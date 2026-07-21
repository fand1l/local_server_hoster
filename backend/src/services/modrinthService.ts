import { ADDON_CATEGORY_BY_KIND } from '../minecraft/addons.js';
import { BadRequestError, ConflictError } from '../errors.js';
import type { AddonService } from './addonService.js';
import type { Logger } from './serverService.js';
import type {
  AddonInfo,
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

interface ModrinthVersion {
  id?: string;
  version_number?: string;
  date_published?: string;
  files?: ModrinthVersionFile[];
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
   * Встановлює останню сумісну версію проєкту: тягне основний .jar і кладе у
   * теку доповнень (через AddonService — ZIP-перевірка + захист шляху).
   */
  async install(record: ServerRecord, projectId: string): Promise<AddonInfo> {
    const loader = MODRINTH_LOADER[record.kind];
    if (!loader) throw new ConflictError('Це ядро не підтримує плагіни чи моди');

    const versionsUrl =
      `${MODRINTH_BASE}/project/${encodeURIComponent(projectId)}/version` +
      `?loaders=${encodeURIComponent(JSON.stringify([loader]))}` +
      `&game_versions=${encodeURIComponent(JSON.stringify([record.version]))}`;

    let versions: ModrinthVersion[];
    try {
      versions = (await fetchJson(versionsUrl)) as ModrinthVersion[];
    } catch (err) {
      throw new ConflictError(
        `Не вдалося отримати версії з Modrinth: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new ConflictError(
        `Немає збірки, сумісної з ${record.version} (${loader}). Спробуйте інший проєкт або версію гри.`,
      );
    }

    // Modrinth не гарантує порядок — беремо найновішу за датою публікації.
    versions.sort((a, b) => (b.date_published ?? '').localeCompare(a.date_published ?? ''));
    const version = versions[0];
    if (!version) {
      throw new ConflictError(`Немає збірки, сумісної з ${record.version} (${loader}).`);
    }
    const file = version.files?.find((f) => f.primary) ?? version.files?.[0];
    if (!file?.url || !file.filename) {
      throw new ConflictError('У цій версії немає файлу для завантаження');
    }

    assertModrinthDownload(file.url);
    const buffer = await this.download(file.url);
    const info = await this.addons.install(record, file.filename, buffer);
    this.log.info(
      `Сервер ${record.name}: з Modrinth встановлено ${projectId} → ${info.filename} (${buffer.length} Б)`,
    );
    return info;
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
