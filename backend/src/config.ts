import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Конфігурація застосунку. Все читається зі змінних середовища,
 * для локального використання дефолти підібрані "щоб просто працювало".
 */
export interface AppConfig {
  /** Інтерфейс, на якому слухає сама панель. За замовчуванням лише localhost. */
  host: string;
  /** Порт веб-панелі. */
  port: number;
  /** Коренева директорія даних панелі (БД + директорії серверів). */
  dataRoot: string;
  /** Директорія, всередині якої створюються папки окремих серверів. */
  serversRoot: string;
  /** Шлях до файлу SQLite. */
  dbFile: string;
  /**
   * На який інтерфейс хоста публікувати ігрові порти контейнерів.
   * 0.0.0.0 — щоб гравці з локальної мережі могли підключитися.
   */
  gameBindHost: string;
  /** Шлях до зібраного фронтенду (frontend/dist) або null, якщо збірки немає (dev-режим). */
  frontendDist: string | null;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Змінна середовища ${name} має бути додатним цілим числом, отримано: "${raw}"`);
  }
  return value;
}

/**
 * true, коли застосунок запущено як самодостатній бінар (pkg/SEA), а не через `node`.
 * pkg виставляє `process.pkg`; у цьому режимі шляхи рахуємо відносно самого exe,
 * а не відносно розташування коду (код лежить у віртуальній ФС снапшоту).
 */
const isPackaged = Boolean((process as { pkg?: unknown }).pkg);

/**
 * Знаходить директорію зібраного фронтенду (має містити index.html):
 *  - явний override MC_HOSTER_FRONTEND_DIR — найвищий пріоритет (для нетипових розкладок);
 *  - запакований бінар: `frontend/dist` поруч із виконуваним файлом (їде сайдкаром у zip);
 *  - dev/збірка tsc: цей файл лежить на 2 рівні нижче кореня репозиторію.
 */
function resolveFrontendDist(): string | null {
  const candidates: string[] = [];

  const override = process.env.MC_HOSTER_FRONTEND_DIR;
  if (override) {
    candidates.push(path.resolve(override));
  } else if (isPackaged) {
    candidates.push(path.join(path.dirname(process.execPath), 'frontend', 'dist'));
  } else {
    // import.meta.url доступний лише в ESM (tsc/tsx); у запакованому бінарі
    // ця гілка недосяжна, тож CJS-бандл ніколи не обчислює цей вираз.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    candidates.push(path.join(repoRoot, 'frontend', 'dist'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function loadConfig(): AppConfig {
  // За замовчуванням дані живуть у домашній директорії користувача:
  // на Windows/macOS Docker Desktop типово має доступ саме до неї,
  // тож bind-mount працюватиме без додаткових налаштувань File Sharing.
  const dataRoot = path.resolve(process.env.MC_HOSTER_DATA_DIR ?? path.join(os.homedir(), '.mc-hoster'));

  const frontendDist = resolveFrontendDist();

  return {
    host: process.env.MC_HOSTER_HOST ?? '127.0.0.1',
    port: intFromEnv('MC_HOSTER_PORT', 8080),
    dataRoot,
    serversRoot: path.join(dataRoot, 'servers'),
    dbFile: path.join(dataRoot, 'mc-hoster.sqlite'),
    gameBindHost: process.env.MC_HOSTER_GAME_BIND_HOST ?? '0.0.0.0',
    frontendDist,
  };
}

/** Створює директорії даних, якщо їх ще немає. */
export function ensureDataDirs(config: AppConfig): void {
  fs.mkdirSync(config.serversRoot, { recursive: true });
}
