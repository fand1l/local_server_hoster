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
