import fs from 'node:fs';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { isPathInside, isValidEntryName, resolveWithin } from '../utils/paths.js';
import type { DirListing, FileEntry, FileTextContent, ServerRecord } from '../types.js';
import type { Logger } from './serverService.js';

/** Понад це — редагувати як текст не даємо (пропонуємо завантажити). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Скільки байтів читати для детекції двійкового вмісту. */
const BINARY_SNIFF_BYTES = 8000;

interface FileServiceDeps {
  log: Logger;
}

/**
 * Файловий менеджер сервера: безпечні операції над файлами у змонтованій теці
 * (record.dataDir) — щоб звичайний користувач не мусив лізти в Docker чи термінал.
 *
 * Уся безпека тримається на resolveWithin: будь-який шлях від користувача
 * резолвиться СТРОГО в межах теки сервера; вихід за межі → 400. Для читання й
 * завантаження додатково перевіряємо realpath (захист від символьних посилань).
 */
export class FileService {
  private readonly log: Logger;

  constructor(deps: FileServiceDeps) {
    this.log = deps.log;
  }

  /** Абсолютний шлях у межах теки сервера або помилка 400. */
  private resolve(record: ServerRecord, relPath: string): string {
    const abs = resolveWithin(record.dataDir, relPath);
    if (abs === null) {
      throw new BadRequestError('Шлях виходить за межі теки сервера');
    }
    return abs;
  }

  /**
   * Головний захист від символьних посилань: РЕАЛЬНИЙ шлях цілі (а якщо ціль ще
   * не існує — найближчого наявного предка) мусить лишатися в межах теки сервера.
   * resolveWithin захищає лише лексично (від «../»); це ловить ще й підкладені
   * всередину теки symlink-и, що вказують назовні (шкідливий плагін/світ або сам
   * MC-процес, який пише у bind-mount). Викликається в УСІХ операціях над ФС.
   */
  private assertContained(record: ServerRecord, abs: string): void {
    const root = fs.realpathSync(record.dataDir);
    // Піднімаємось до першого шляху, що реально існує (ціль може ще не бути створена).
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break; // корінь ФС — далі нікуди
      probe = parent;
    }
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch {
      throw new BadRequestError('Не вдалося перевірити шлях');
    }
    if (real !== root && !isPathInside(root, real)) {
      throw new BadRequestError('Доступ за символьним посиланням поза текою сервера заборонено');
    }
  }

  /** Список вмісту директорії (теки — першими, далі за іменем). */
  list(record: ServerRecord, relPath: string): DirListing {
    const abs = this.resolve(record, relPath);
    this.assertContained(record, abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new NotFoundError('Теку не знайдено');
    }
    if (!stat.isDirectory()) {
      throw new BadRequestError('Це не тека');
    }

    const entries: FileEntry[] = fs
      .readdirSync(abs, { withFileTypes: true })
      .map((dirent) => {
        const full = path.join(abs, dirent.name);
        let entryStat: fs.Stats | null = null;
        try {
          // lstat, НЕ statSync: символьні посилання не розіменовуємо — інакше
          // symlink на теку показувався б як тека і в нього можна було б «зайти»
          // (навігацію все одно заблокує assertContained, але не спокушаємо).
          entryStat = fs.lstatSync(full);
        } catch {
          // Битий симлінк тощо — показуємо як файл нульового розміру.
        }
        // Symlink (навіть на теку) показуємо як файл — заходити в нього не можна.
        const isDir = entryStat
          ? entryStat.isDirectory()
          : dirent.isDirectory() && !dirent.isSymbolicLink();
        return {
          name: dirent.name,
          type: (isDir ? 'directory' : 'file') as FileEntry['type'],
          sizeBytes: isDir ? 0 : (entryStat?.size ?? 0),
          modifiedAt: (entryStat?.mtime ?? new Date(0)).toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return { path: this.relOf(record, abs), entries };
  }

  /** Читає текстовий файл (відхиляє двійкові та завеликі — їх лише завантажують). */
  readText(record: ServerRecord, relPath: string): FileTextContent {
    const abs = this.resolve(record, relPath);
    this.assertContained(record, abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new NotFoundError('Файл не знайдено');
    }
    if (stat.isDirectory()) throw new BadRequestError('Це тека, а не файл');
    if (stat.size > MAX_TEXT_BYTES) {
      throw new BadRequestError('Файл завеликий для редагування — завантажте його');
    }

    const buffer = fs.readFileSync(abs);
    if (looksBinary(buffer)) {
      throw new BadRequestError('Двійковий файл — редагування недоступне, завантажте його');
    }
    return { path: this.relOf(record, abs), content: buffer.toString('utf8') };
  }

  /** Зберігає текст у файл (атомарно). Створює батьківські теки за потреби. */
  writeText(record: ServerRecord, relPath: string, content: string): FileTextContent {
    const abs = this.resolve(record, relPath);
    // ВАЖЛИВО: перевіряємо ДО запису — запис через symlink назовні не відкотиш.
    this.assertContained(record, abs);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      throw new BadRequestError('Не можна записати текст у теку');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
      throw new BadRequestError('Забагато тексту');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, abs);
    this.log.info(`Сервер ${record.name}: збережено файл ${this.relOf(record, abs)}`);
    return this.readText(record, this.relOf(record, abs));
  }

  /** Записує завантажений файл у вказану теку (з перевіркою імені). */
  upload(record: ServerRecord, dirRelPath: string, filename: string, content: Buffer): FileEntry {
    if (!isValidEntryName(filename)) {
      throw new BadRequestError('Некоректне ім’я файлу');
    }
    const dirAbs = this.resolve(record, dirRelPath);
    // Тека призначення (з урахуванням symlink-ів) має бути в межах теки сервера.
    this.assertContained(record, dirAbs);
    fs.mkdirSync(dirAbs, { recursive: true });
    const targetRel = path.join(this.relOf(record, dirAbs), filename);
    const target = this.resolve(record, targetRel);

    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
    this.log.info(`Сервер ${record.name}: завантажено ${targetRel} (${content.length} Б)`);
    const stat = fs.statSync(target);
    return { name: filename, type: 'file', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  /** Створює теку. */
  mkdir(record: ServerRecord, dirRelPath: string, name: string): FileEntry {
    if (!isValidEntryName(name)) {
      throw new BadRequestError('Некоректне ім’я теки');
    }
    const parent = this.resolve(record, dirRelPath);
    this.assertContained(record, parent);
    const target = this.resolve(record, path.join(this.relOf(record, parent), name));
    if (fs.existsSync(target)) {
      throw new ConflictError('Файл або тека з такою назвою вже існує');
    }
    fs.mkdirSync(target, { recursive: false });
    this.log.info(`Сервер ${record.name}: створено теку ${this.relOf(record, target)}`);
    return { name, type: 'directory', sizeBytes: 0, modifiedAt: new Date().toISOString() };
  }

  /** Перейменовує файл/теку в межах тієї самої батьківської теки. */
  rename(record: ServerRecord, relPath: string, newName: string): FileEntry {
    if (!isValidEntryName(newName)) {
      throw new BadRequestError('Некоректне нове ім’я');
    }
    const abs = this.resolve(record, relPath);
    if (!fs.existsSync(abs)) throw new NotFoundError('Файл або теку не знайдено');
    // Джерело (з урахуванням symlink-ів) має бути в межах теки; ціль — той самий батько.
    this.assertContained(record, abs);
    const target = path.join(path.dirname(abs), newName);
    // target обов'язково всередині кореня (той самий батько, валідне ім'я) — але перевіримо.
    this.resolve(record, path.relative(record.dataDir, target));
    if (fs.existsSync(target)) {
      throw new ConflictError('Назва вже зайнята');
    }
    fs.renameSync(abs, target);
    this.log.info(`Сервер ${record.name}: ${this.relOf(record, abs)} → ${newName}`);
    const stat = fs.statSync(target);
    return {
      name: newName,
      type: stat.isDirectory() ? 'directory' : 'file',
      sizeBytes: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  /** Видаляє файл або теку (рекурсивно). Корінь видаляти не можна. */
  remove(record: ServerRecord, relPath: string): void {
    const abs = this.resolve(record, relPath);
    if (abs === path.resolve(record.dataDir)) {
      throw new BadRequestError('Не можна видалити кореневу теку сервера');
    }
    if (!fs.existsSync(abs)) return; // уже немає — ідемпотентність
    // Не даємо видаляти крізь symlink назовні (rm -rf чужих файлів).
    this.assertContained(record, abs);
    fs.rmSync(abs, { recursive: true, force: true });
    this.log.info(`Сервер ${record.name}: видалено ${this.relOf(record, abs)}`);
  }

  /** Готує файл до завантаження (стрімінгу): перевіряє межі й що це файл. */
  resolveForDownload(
    record: ServerRecord,
    relPath: string,
  ): { absPath: string; filename: string; sizeBytes: number } {
    const abs = this.resolve(record, relPath);
    this.assertContained(record, abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new NotFoundError('Файл не знайдено');
    }
    if (stat.isDirectory()) throw new BadRequestError('Не можна завантажити теку');
    return { absPath: abs, filename: path.basename(abs), sizeBytes: stat.size };
  }

  /** Абсолютний шлях → відносний до кореня теки сервера (з прямими слешами). */
  private relOf(record: ServerRecord, abs: string): string {
    const rel = path.relative(path.resolve(record.dataDir), abs);
    return rel.split(path.sep).join('/');
  }
}

/** Двійковий, якщо у перших байтах є нульовий байт. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
