import fs from 'node:fs';
import path from 'node:path';
import { BadRequestError } from '../errors.js';
import type { PropertyEntry } from '../types.js';

/**
 * Парсер/сериалізатор server.properties.
 *
 * Формат — java properties у тому вигляді, в якому його пише сам Minecraft:
 * рядки "key=value", коментарі з "#". Ми зберігаємо файл ПОРЯДКОВО:
 * коментарі, порожні рядки та порядок ключів залишаються на місці,
 * оновлюються лише значення. Невідомі панелі ключі не губляться.
 */

const PROPERTIES_FILE = 'server.properties';

/** Допустимий ключ properties (те, що реально генерує Minecraft + запас). */
export const PROPERTY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ParsedLine =
  | { kind: 'raw'; raw: string } // коментар або порожній рядок — зберігаємо як є
  | { kind: 'pair'; key: string; value: string };

export function propertiesFilePath(dataDir: string): string {
  return path.join(dataDir, PROPERTIES_FILE);
}

function parse(content: string): ParsedLine[] {
  const lines = content.split(/\r?\n/);
  // split лишає порожній "хвіст", якщо файл закінчується переносом рядка.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.map((line): ParsedLine => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      return { kind: 'raw', raw: line };
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      // Рядок без '=' — не чіпаємо, щоб нічого не зламати.
      return { kind: 'raw', raw: line };
    }
    return { kind: 'pair', key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
  });
}

function serialize(lines: ParsedLine[]): string {
  const out = lines.map((line) => (line.kind === 'pair' ? `${line.key}=${line.value}` : line.raw));
  return `${out.join('\n')}\n`;
}

export interface PropertiesFileState {
  /** false — сервер ще жодного разу не запускався, файл не згенеровано. */
  exists: boolean;
  entries: PropertyEntry[];
}

/** Читає server.properties із директорії сервера. */
export function readServerProperties(dataDir: string): PropertiesFileState {
  const file = propertiesFilePath(dataDir);
  if (!fs.existsSync(file)) {
    return { exists: false, entries: [] };
  }
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  const entries = parsed
    .filter((line): line is Extract<ParsedLine, { kind: 'pair' }> => line.kind === 'pair')
    .map(({ key, value }) => ({ key, value }));
  return { exists: true, entries };
}

/**
 * Оновлює значення у server.properties:
 *  - наявні ключі отримують нові значення (на місці, з коментарями довкола);
 *  - нові ключі дописуються у кінець файлу;
 *  - решта вмісту не змінюється.
 * Запис атомарний (tmp-файл + rename), щоб збій не лишив половину файлу.
 */
export function updateServerProperties(dataDir: string, updates: PropertyEntry[]): PropertiesFileState {
  const file = propertiesFilePath(dataDir);
  if (!fs.existsSync(file)) {
    throw new BadRequestError(
      'Файл server.properties ще не створено. Запустіть сервер хоча б один раз — Minecraft згенерує його сам.',
    );
  }

  for (const { key, value } of updates) {
    if (!PROPERTY_KEY_PATTERN.test(key)) {
      throw new BadRequestError(`Недопустимий ключ properties: "${key}"`);
    }
    if (/[\r\n]/.test(value)) {
      throw new BadRequestError(`Значення ключа "${key}" не може містити перенос рядка`);
    }
  }

  const lines = parse(fs.readFileSync(file, 'utf8'));
  const pending = new Map(updates.map(({ key, value }) => [key, value]));

  for (const line of lines) {
    if (line.kind === 'pair' && pending.has(line.key)) {
      line.value = pending.get(line.key)!;
      pending.delete(line.key);
    }
  }
  // Ключі, яких у файлі не було, акуратно дописуємо в кінець.
  for (const [key, value] of pending) {
    lines.push({ kind: 'pair', key, value });
  }

  const tmpFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, serialize(lines), 'utf8');
  fs.renameSync(tmpFile, file);

  return readServerProperties(dataDir);
}
