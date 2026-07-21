import fs from 'node:fs';
import path from 'node:path';
import { addonDirFor, ADDON_CATEGORY_BY_KIND, sanitizeJarName } from '../minecraft/addons.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { isPathInside } from '../utils/paths.js';
import type { AddonInfo, AddonsResponse, ServerRecord } from '../types.js';
import type { ContainerManager } from '../docker/containerManager.js';
import { isDockerAvailable } from '../docker/client.js';
import type { Logger } from './serverService.js';

/** Магічні байти ZIP/JAR: "PK\x03\x04" (або порожній архів "PK\x05\x06"). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];

interface AddonServiceDeps {
  containers: ContainerManager;
  log: Logger;
}

/**
 * Керування плагінами/модами сервера — простими файловими операціями у
 * змонтованій теці plugins/ або mods/ (jar-и лежать на хості). Прямого
 * встановлення з Modrinth поки немає: користувач перетягує .jar у панель.
 */
export class AddonService {
  private readonly containers: ContainerManager;
  private readonly log: Logger;

  constructor(deps: AddonServiceDeps) {
    this.containers = deps.containers;
    this.log = deps.log;
  }

  async list(record: ServerRecord): Promise<AddonsResponse> {
    const category = ADDON_CATEGORY_BY_KIND[record.kind];
    if (!category) {
      return {
        supported: false,
        category: null,
        addons: [],
        requiresRestart: false,
        warning: 'Vanilla не підтримує плагіни чи моди — оберіть Paper/Spigot (плагіни) або Fabric/Forge/NeoForge (моди).',
      };
    }

    const dir = addonDirFor(record.dataDir, record.kind)!;
    const addons = this.readJarFiles(dir);
    const running = await this.isRunning(record);

    return {
      supported: true,
      category,
      addons,
      requiresRestart: running,
      warning: running ? 'Сервер запущено: встановлені/видалені файли застосуються після перезапуску.' : null,
    };
  }

  /**
   * Встановлює (перезаписує) .jar у теку доповнень. Перевіряє розширення,
   * ZIP-сигнатуру (jar — це zip) і що шлях лишається всередині теки сервера.
   */
  async install(record: ServerRecord, rawName: string, content: Buffer): Promise<AddonInfo> {
    const category = ADDON_CATEGORY_BY_KIND[record.kind];
    if (!category) {
      throw new ConflictError('Це ядро не підтримує плагіни чи моди');
    }
    const filename = sanitizeJarName(rawName);

    if (content.length === 0) {
      throw new BadRequestError('Порожній файл');
    }
    if (!hasZipMagic(content)) {
      throw new BadRequestError('Файл не схожий на .jar (немає сигнатури ZIP)');
    }

    const dir = addonDirFor(record.dataDir, record.kind)!;
    const target = path.join(dir, filename);
    // Подвійний захист: цільовий шлях має лежати строго всередині теки доповнень.
    if (!isPathInside(dir, target)) {
      throw new BadRequestError('Недопустимий шлях призначення');
    }

    fs.mkdirSync(dir, { recursive: true });
    // Атомарний запис: tmp + rename, щоб сервер не підхопив половину файлу.
    const tmp = path.join(dir, `.${filename}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);

    this.log.info(`Сервер ${record.name}: встановлено ${category}/${filename} (${content.length} Б)`);
    const stat = fs.statSync(target);
    return { filename, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  async remove(record: ServerRecord, rawName: string): Promise<void> {
    const category = ADDON_CATEGORY_BY_KIND[record.kind];
    if (!category) {
      throw new ConflictError('Це ядро не підтримує плагіни чи моди');
    }
    const filename = sanitizeJarName(rawName);
    const dir = addonDirFor(record.dataDir, record.kind)!;
    const target = path.join(dir, filename);
    if (!isPathInside(dir, target)) {
      throw new BadRequestError('Недопустимий шлях');
    }
    if (!fs.existsSync(target)) {
      // Уже немає — вважаємо успіхом (ідемпотентність).
      return;
    }
    fs.rmSync(target, { force: true });
    this.log.info(`Сервер ${record.name}: видалено ${category}/${filename}`);
  }

  // ------------------------------------------------------------ допоміжне

  private readJarFiles(dir: string): AddonInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // теки ще немає (сервер не запускався) — доповнень немає
    }
    return entries
      .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
      .map((e) => {
        const stat = fs.statSync(path.join(dir, e.name));
        return { filename: e.name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }

  private async isRunning(record: ServerRecord): Promise<boolean> {
    if (!record.containerId || !(await isDockerAvailable())) return false;
    const state = await this.containers.inspectState(record.containerId).catch(() => null);
    return state?.running ?? false;
  }
}

function hasZipMagic(buf: Buffer): boolean {
  const matches = (magic: number[]) => magic.every((byte, i) => buf[i] === byte);
  return matches(ZIP_MAGIC) || matches(ZIP_EMPTY_MAGIC);
}
