import path from 'node:path';

/**
 * Перетворює абсолютний шлях хоста на форму, придатну для Docker bind-mount.
 *
 * На Windows Docker Desktop приймає шляхи виду "C:/Users/me/dir"
 * (зворотні слеші всередині рядка Binds можуть трактуватися як екранування),
 * тому просто нормалізуємо роздільники. На Linux/macOS шлях повертається як є.
 */
export function toDockerBindPath(absPath: string): string {
  if (process.platform === 'win32') {
    return absPath.replace(/\\/g, '/');
  }
  return absPath;
}

/**
 * Безпечна перевірка перед видаленням даних: шлях має бути СУВОРО всередині root.
 * Захищає від випадкового rm -rf чогось за межами директорії серверів
 * (наприклад, якщо у БД якимось чином опинився зіпсований шлях).
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Резолвить відносний шлях від користувача В МЕЖАХ root і повертає абсолютний.
 * Це головний захист файлового менеджера від path traversal: усі провідні
 * слеші відкидаються, а результат має бути або самим root, або строго всередині.
 * Повертає null, якщо шлях виходить за межі (виклик має перетворити це на 400).
 */
export function resolveWithin(root: string, relPath: string): string | null {
  // Провідні «/» чи «\» роблять шлях відносним, а не абсолютним.
  const cleaned = (relPath ?? '').replace(/^[/\\]+/, '');
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, cleaned);
  if (abs === rootAbs || isPathInside(rootAbs, abs)) return abs;
  return null;
}

/** Валідне ім'я файлу/теки в межах одного рівня (без роздільників і переходів). */
export function isValidEntryName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // Керівні символи (0x00–0x1F) забороняємо.
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 0x20) return false;
  }
  return true;
}
