import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';

/**
 * Створює Fastify-застосунок: базові плагіни, глобальний error handler,
 * роздача зібраного фронтенду. Роути реєструються окремо (див. index.ts) —
 * так сервіси можуть використовувати app.log без циклічних залежностей.
 */
export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Полінг фронтенду кожні кілька секунд — без цього лог перетворюється на шум.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // WebSocket-підтримка має бути зареєстрована ДО оголошення ws-роутів.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 }, // команди консолі — маленькі
  });

  // Завантаження плагінів/модів (multipart). Моди бувають великі — ліміт 250 МБ.
  await app.register(fastifyMultipart, {
    limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  });

  // Захист від DNS-rebinding і крос-доменних запитів. Панель не має
  // автентифікації (розрахована на localhost), тож без цього шкідливий сайт у
  // браузері міг би через rebinding звертатися до API (створювати/видаляти
  // сервери, писати файли) або відкрити крос-доменний WebSocket консолі.
  registerOriginGuard(app, config);

  // Толерантний JSON-парсер: POST без тіла (start/stop/restart) — це нормально,
  // навіть якщо клієнт за звичкою поставив Content-Type: application/json.
  // Стандартний парсер Fastify у цьому випадку відповідає помилкою
  // FST_ERR_CTP_EMPTY_JSON_BODY — саме її ми тут прибираємо.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('Некоректний JSON у тілі запиту') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Єдиний формат помилок API: { error: { code, message } }.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message } });
    }
    // Помилки самого Fastify (битий JSON тощо) мають statusCode; решта — 500.
    const httpError = err as { statusCode?: number; message?: string };
    const status = typeof httpError.statusCode === 'number' ? httpError.statusCode : 500;
    if (status >= 500) {
      req.log.error(err); // несподіване — у лог повністю
    }
    return reply.code(status).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: status >= 500 ? 'Внутрішня помилка панелі' : (httpError.message ?? 'Помилка запиту'),
      },
    });
  });

  // Продакшен-режим: бекенд сам віддає збірку фронтенду (один порт на все).
  if (config.frontendDist) {
    await app.register(fastifyStatic, { root: config.frontendDist });

    // SPA-fallback: будь-який не-API GET → index.html (роутинг у браузері).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Не знайдено' } });
    });
  }

  return app;
}

/** Loopback-хости, дозволені за замовчуванням (панель слухає саме їх). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** hostname із заголовка Host/Origin без порту (IPv6 у дужках → без дужок). */
function hostnameOf(value: string): string {
  let name = value.trim().toLowerCase();
  const at = name.lastIndexOf('@'); // про всяк випадок відкидаємо user-info
  if (at !== -1) name = name.slice(at + 1);
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    return end === -1 ? name.slice(1) : name.slice(1, end); // [::1]:8080 → ::1
  }
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(0, colon);
}

/**
 * onRequest-гард: перевіряє заголовки Host та Origin.
 *
 *  - Host: якщо панель слухає loopback (типовий випадок) або задано
 *    MC_HOSTER_ALLOWED_HOSTS — приймаємо лише запити з дозволеним Host.
 *    Це зупиняє DNS-rebinding (шкідливий домен, переприв'язаний на 127.0.0.1).
 *  - Origin: браузер завжди додає його для крос-доменних (і WebSocket) запитів.
 *    Дозволяємо лише свій хост → крос-доменний CSRF/WS не пройде. Клієнти без
 *    браузера (curl тощо) Origin не шлють — їх це не стосується.
 *
 * Якщо панель свідомо відкрито назовні (MC_HOSTER_HOST не loopback) і білого
 * списку не задано — перевірку Host вимикаємо (адмін узяв ризик на себе),
 * але про це попереджаємо в лог.
 */
function registerOriginGuard(app: FastifyInstance, config: AppConfig): void {
  const explicit = (process.env.MC_HOSTER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const hostAllowlist: Set<string> | null =
    explicit.length > 0
      ? new Set(explicit)
      : LOOPBACK_HOSTS.has(config.host.toLowerCase())
        ? LOOPBACK_HOSTS
        : null; // не-loopback без явного списку → перевірку Host не застосовуємо

  if (hostAllowlist === null) {
    app.log.warn(
      `Панель слухає ${config.host} (не loopback) без MC_HOSTER_ALLOWED_HOSTS — ` +
        'перевірку Host вимкнено (ризик DNS-rebinding). Задайте MC_HOSTER_ALLOWED_HOSTS=your.host',
    );
  }

  const isAllowedHost = (name: string): boolean =>
    hostAllowlist === null || hostAllowlist.has(name);

  app.addHook('onRequest', async (req, reply) => {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';

    // 1. Host — захист від DNS-rebinding (лише коли є білий список).
    if (hostAllowlist && !isAllowedHost(hostnameOf(hostHeader))) {
      return reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN_HOST', message: 'Некоректний заголовок Host' } });
    }

    // 2. Origin — блокуємо крос-доменні запити (у т.ч. WebSocket консолі).
    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader && originHeader !== 'null') {
      let originHost: string;
      try {
        originHost = new URL(originHeader).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Некоректний Origin' } });
      }
      const sameAsHost = hostHeader ? originHost === hostnameOf(hostHeader) : false;
      if (!sameAsHost && !isAllowedHost(originHost)) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN_ORIGIN', message: 'Крос-доменний запит заборонено' },
        });
      }
    }
  });
}
