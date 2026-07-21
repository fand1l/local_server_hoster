import path from 'node:path';
import { BadRequestError } from '../errors.js';
import type { AddonCategory, ServerKind } from '../types.js';

/**
 * Куди складати доповнення кожного ядра. Тека лежить у змонтованій директорії
 * сервера, тож панель працює з нею як зі звичайними файлами на хості:
 *  - Paper / Spigot → plugins/ (плагіни Bukkit/Spigot);
 *  - Fabric / Forge / NeoForge → mods/ (моди);
 *  - Vanilla → немає завантажувача, доповнення не підтримуються.
 */
export const ADDON_CATEGORY_BY_KIND: Record<ServerKind, AddonCategory | null> = {
  PAPER: 'plugins',
  SPIGOT: 'plugins',
  FABRIC: 'mods',
  FORGE: 'mods',
  NEOFORGE: 'mods',
  VANILLA: null,
};

/** Абсолютний шлях до теки доповнень сервера, або null для Vanilla. */
export function addonDirFor(dataDir: string, kind: ServerKind): string | null {
  const category = ADDON_CATEGORY_BY_KIND[kind];
  return category ? path.join(dataDir, category) : null;
}

/**
 * Перевіряє й нормалізує ім'я файлу плагіна/мода:
 *  - лише .jar;
 *  - жодних шляхів/переходів (захист від path traversal) — беремо basename;
 *  - розумна довжина й набір символів.
 * Повертає безпечний basename або кидає BadRequestError.
 */
export function sanitizeJarName(rawName: string): string {
  const base = path.basename(rawName.trim());

  if (!base || base === '.' || base === '..') {
    throw new BadRequestError('Некоректне ім’я файлу');
  }
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) {
    throw new BadRequestError('Ім’я файлу містить недопустимі символи');
  }
  if (base.length > 200) {
    throw new BadRequestError('Ім’я файлу задовге');
  }
  if (!/\.jar$/i.test(base)) {
    throw new BadRequestError('Дозволені лише .jar-файли');
  }
  return base;
}
