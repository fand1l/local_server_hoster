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

export function loadConfig(): AppConfig {
  // За замовчуванням дані живуть у домашній директорії користувача:
  // на Windows/macOS Docker Desktop типово має доступ саме до неї,
  // тож bind-mount працюватиме без додаткових налаштувань File Sharing.
  const dataRoot = path.resolve(process.env.MC_HOSTER_DATA_DIR ?? path.join(os.homedir(), '.mc-hoster'));

  // І у dev (src/), і у збірці (dist/) цей файл лежить на 2 рівні нижче кореня репозиторію.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const distCandidate = path.join(repoRoot, 'frontend', 'dist');
  const frontendDist = fs.existsSync(path.join(distCandidate, 'index.html')) ? distCandidate : null;

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
