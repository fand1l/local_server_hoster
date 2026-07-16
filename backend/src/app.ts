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
