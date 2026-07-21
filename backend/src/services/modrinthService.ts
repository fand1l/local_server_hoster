import { ADDON_CATEGORY_BY_KIND } from '../minecraft/addons.js';
import { BadRequestError, ConflictError } from '../errors.js';
import type { AddonService } from './addonService.js';
import type { Logger } from './serverService.js';
import type {
  AddonInfo,
  AddonInstallResult,
  AddonSearchHit,
  AddonSearchResponse,
  ServerKind,
  ServerRecord,
} from '../types.js';

/**
 * Встановлення контенту (плагінів/модів) з Modrinth прямо з панелі —
 * щоб не шукати .jar по сайтах і не тягати вручну.
 *
 * Пошук і версії фільтруються під ЯДРО й ВЕРСІЮ ГРИ сервера, тож у видачу
 * потрапляє лише сумісне. Встановлення = завантаження основного .jar останньої
 * сумісної версії у теку plugins/ або mods/ (через AddonService — з перевіркою
 * ZIP-сигнатури й захистом шляху). Модпаки тут НЕ встановлюються: вони
 * переозначають весь сервер (версію, лоадер, набір модів) — це окремий потік.
 */

const MODRINTH_BASE = process.env.MC_HOSTER_MODRINTH_URL ?? 'https://api.modrinth.com/v2';
/** CDN, з якого Modrinth віддає файли (перевизначається для тестів). */
const MODRINTH_CDN_HOST = process.env.MC_HOSTER_MODRINTH_CDN_HOST ?? 'cdn.modrinth.com';
const FETCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const USER_AGENT = 'mc-hoster (local panel)';
const SEARCH_LIMIT = 20;
/** Глибина рекурсії залежностей і стеля кількості файлів (захист від дерев-монстрів). */
const MAX_DEPENDENCY_DEPTH = 5;
const MAX_TOTAL_FILES = 30;

/** Наше ядро → лоадер у термінах Modrinth (Vanilla не має завантажувача). */
const MODRINTH_LOADER: Partial<Record<ServerKind, string>> = {
  PAPER: 'paper',
  SPIGOT: 'spigot',
  FABRIC: 'fabric',
  FORGE: 'forge',
  NEOFORGE: 'neoforge',
};

interface ModrinthSearchHit {
  project_id?: string;
  slug?: string;
  title?: string;
  description?: string;
  author?: string;
  downloads?: number;
  icon_url?: string | null;
}

interface ModrinthVersionFile {
  url?: string;
  filename?: string;
  primary?: boolean;
  size?: number;
}

interface ModrinthDependency {
  project_id?: string | null;
  version_id?: string | null;
  /** required | optional | incompatible | embedded. */
  dependency_type?: string;
}

interface ModrinthVersion {
  id?: string;
  project_id?: string;
  name?: string;
  version_number?: string;
  date_published?: string;
  files?: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

interface ModrinthServiceDeps {
  addons: AddonService;
  log: Logger;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} від ${url}`);
  return response.json();
}

export class ModrinthService {
  private readonly addons: AddonService;
  private readonly log: Logger;

  constructor(deps: ModrinthServiceDeps) {
    this.addons = deps.addons;
    this.log = deps.log;
  }

  /**
   * Пошук проєктів під ядро+версію сервера. Порожній запит → популярні
   * (сортування за завантаженнями). Без мережі повертає source='offline'
   * з порожньою видачею, щоб UI показав підказку, а не помилку.
   */
  async search(record: ServerRecord, query: string, offset: number): Promise<AddonSearchResponse> {
    const category = ADDON_CATEGORY_BY_KIND[record.kind];
    const loader = MODRINTH_LOADER[record.kind];
    if (!category || !loader) {
      throw new ConflictError('Це ядро не підтримує плагіни чи моди');
    }

    // facets Modrinth: лоадер і версія — у categories/versions; project_type:mod
    // відсікає модпаки/ресурспаки (плагіни Modrinth класифікує теж як "mod").
    const facets = JSON.stringify([
      [`categories:${loader}`],
      [`versions:${record.version}`],
      ['project_type:mod'],
    ]);
    const params = new URLSearchParams({
      query: query.trim(),
      facets,
      limit: String(SEARCH_LIMIT),
      offset: String(offset),
      index: query.trim() ? 'relevance' : 'downloads',
    });

    try {
      const data = (await fetchJson(`${MODRINTH_BASE}/search?${params.toString()}`)) as {
        hits?: ModrinthSearchHit[];
        total_hits?: number;
      };
      const hits: AddonSearchHit[] = (data.hits ?? [])
        .filter((h): h is ModrinthSearchHit & { project_id: string } => typeof h.project_id === 'string')
        .map((h) => ({
          projectId: h.project_id,
          slug: h.slug ?? h.project_id,
          title: h.title ?? h.slug ?? h.project_id,
          description: h.description ?? '',
          author: h.author ?? '',
          downloads: typeof h.downloads === 'number' ? h.downloads : 0,
          iconUrl: h.icon_url ?? null,
        }));
      return { hits, total: data.total_hits ?? hits.length, offset, category, source: 'online' };
    } catch (err) {
      this.log.warn(`Пошук Modrinth не вдався: ${err instanceof Error ? err.message : err}`);
      return { hits: [], total: 0, offset, category, source: 'offline' };
    }
  }

  /**
   * Встановлює проєкт із Modrinth разом з ОБОВ'ЯЗКОВИМИ залежностями (рекурсивно):
   * тягне основний .jar, потім кожну required-залежність (Fabric API тощо), щоб
   * плагін/мод справді запрацював. Незадоволені залежності не валять встановлення —
   * повертаються у warnings, щоб UI показав, що доставити вручну.
   */
  async install(record: ServerRecord, projectId: string): Promise<AddonInstallResult> {
    const loader = MODRINTH_LOADER[record.kind];
    if (!loader) throw new ConflictError('Це ядро не підтримує плагіни чи моди');

    const version = await this.resolveVersion(record, loader, projectId, null);
    if (!version) {
      throw new ConflictError(
        `Немає збірки, сумісної з ${record.version} (${loader}). Спробуйте інший проєкт або версію гри.`,
      );
    }

    const installed: AddonInfo[] = [];
    const warnings: string[] = [];
    // Дедуплікація за project_id, щоб спільні залежності не тягнулись двічі й не було циклів.
    const visited = new Set<string>([projectId.toLowerCase()]);
    if (version.project_id) visited.add(version.project_id.toLowerCase());

    const main = await this.downloadAndInstall(record, version);
    installed.push(main);
    this.log.info(`Сервер ${record.name}: з Modrinth встановлено ${projectId} → ${main.filename}`);

    await this.installRequiredDeps(record, loader, version, installed, warnings, visited, 1);

    return {
      main,
      installed,
      dependencyCount: installed.length - 1,
      warnings,
    };
  }

  /**
   * Рекурсивно встановлює обов'язкові залежності версії. Кожна помилка — це
   * warning, а не виняток: головний плагін уже стоїть, а користувач має знати,
   * чого бракує.
   */
  private async installRequiredDeps(
    record: ServerRecord,
    loader: string,
    parent: ModrinthVersion,
    installed: AddonInfo[],
    warnings: string[],
    visited: Set<string>,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DEPENDENCY_DEPTH) return;
    for (const dep of parent.dependencies ?? []) {
      if (dep.dependency_type !== 'required') continue; // optional/embedded/incompatible пропускаємо
      const depProject = dep.project_id ?? undefined;
      const depVersionId = dep.version_id ?? undefined;
      const key = (depProject ?? depVersionId ?? '').toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);

      if (installed.length >= MAX_TOTAL_FILES) {
        warnings.push('Забагато залежностей — решту не встановлено автоматично.');
        return;
      }

      const depVersion = await this.resolveVersion(record, loader, depProject ?? '', depVersionId ?? null);
      if (!depVersion) {
        warnings.push(
          `Обов'язкову залежність (${depProject ?? depVersionId}) не встановлено — немає сумісної версії. Доставте вручну.`,
        );
        continue;
      }
      if (depVersion.project_id) visited.add(depVersion.project_id.toLowerCase());

      try {
        const info = await this.downloadAndInstall(record, depVersion);
        installed.push(info);
        this.log.info(`Сервер ${record.name}: залежність ${depProject} → ${info.filename}`);
        // Транзитивні залежності (залежність залежності).
        await this.installRequiredDeps(record, loader, depVersion, installed, warnings, visited, depth + 1);
      } catch (err) {
        warnings.push(
          `Залежність ${depProject ?? depVersionId} не встановлено: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Знаходить версію проєкту: або конкретну (pinnedVersionId, як вимагає
   * залежність), або останню сумісну з ядром+версією гри. null — немає збірки.
   */
  private async resolveVersion(
    record: ServerRecord,
    loader: string,
    projectId: string,
    pinnedVersionId: string | null,
  ): Promise<ModrinthVersion | null> {
    try {
      if (pinnedVersionId) {
        const version = (await fetchJson(
          `${MODRINTH_BASE}/version/${encodeURIComponent(pinnedVersionId)}`,
        )) as ModrinthVersion | null;
        return version ?? null;
      }
      if (!projectId) return null;
      const url =
        `${MODRINTH_BASE}/project/${encodeURIComponent(projectId)}/version` +
        `?loaders=${encodeURIComponent(JSON.stringify([loader]))}` +
        `&game_versions=${encodeURIComponent(JSON.stringify([record.version]))}`;
      const versions = (await fetchJson(url)) as ModrinthVersion[];
      if (!Array.isArray(versions) || versions.length === 0) return null;
      // Modrinth не гарантує порядок — беремо найновішу за датою публікації.
      versions.sort((a, b) => (b.date_published ?? '').localeCompare(a.date_published ?? ''));
      return versions[0] ?? null;
    } catch (err) {
      this.log.warn(`Не вдалося отримати версію Modrinth: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Тягне основний .jar версії й безпечно кладе у теку доповнень (через AddonService). */
  private async downloadAndInstall(record: ServerRecord, version: ModrinthVersion): Promise<AddonInfo> {
    const file = version.files?.find((f) => f.primary) ?? version.files?.[0];
    if (!file?.url || !file.filename) {
      throw new ConflictError('У цій версії немає файлу для завантаження');
    }
    assertModrinthDownload(file.url);
    const buffer = await this.download(file.url);
    return this.addons.install(record, file.filename, buffer);
  }

  private async download(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      throw new ConflictError(
        `Не вдалося завантажити файл: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) throw new ConflictError(`Завантаження не вдалося (HTTP ${response.status})`);

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new BadRequestError('Файл завеликий (ліміт 250 МБ)');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new BadRequestError('Файл завеликий (ліміт 250 МБ)');
    }
    if (buffer.length === 0) throw new ConflictError('Modrinth повернув порожній файл');
    return buffer;
  }
}

/**
 * Захист від SSRF: завантажуємо ЛИШЕ з CDN Modrinth (або хоста, заданого
 * MODRINTH_BASE — для тестів із локальним моком). URL файлу приходить із
 * відповіді Modrinth, але додатково звіряємо хост.
 */
function assertModrinthDownload(fileUrl: string): void {
  let host: string;
  try {
    host = new URL(fileUrl).hostname.toLowerCase();
  } catch {
    throw new BadRequestError('Некоректний URL файлу');
  }
  const baseHost = safeHost(MODRINTH_BASE);
  if (host !== MODRINTH_CDN_HOST.toLowerCase() && host !== baseHost) {
    throw new BadRequestError('Завантаження дозволене лише з Modrinth');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
