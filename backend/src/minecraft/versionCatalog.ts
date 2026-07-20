import type { CoreVersionsResult, ServerKind, VersionListResult } from '../types.js';

/**
 * Каталог версій: живі списки версій гри та версій ядра з офіційних API.
 *
 * Джерела:
 *  - Mojang version manifest — усі релізи Minecraft (для Vanilla і як довідник);
 *  - PaperMC API — версії гри, які підтримує Paper, і білди під кожну версію
 *    (пробуємо v2 api.papermc.io, а якщо він недоступний — новіший Fill v3);
 *  - FabricMC meta — стабільні версії гри та версії лоадера під конкретну версію.
 *
 * Сумісність «версія гри ↔ версія ядра» гарантована структурою API: список
 * білдів/лоадерів запитується ПІД конкретну версію гри, тож нічого несумісного
 * у виборі просто не з'являється.
 *
 * Стійкість: відповіді кешуються (TTL), а якщо мережі немає — повертається
 * вбудований fallback-список із позначкою source='fallback' (UI дозволяє ввести
 * версію вручну). Базові URL перевизначаються env-змінними — це використовують
 * e2e-тести з локальним мок-сервером.
 */

const MOJANG_MANIFEST_URL =
  process.env.MC_HOSTER_MOJANG_META_URL ??
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_V2_BASE = process.env.MC_HOSTER_PAPER_META_URL ?? 'https://api.papermc.io/v2';
const PAPER_FILL_BASE = process.env.MC_HOSTER_PAPER_FILL_URL ?? 'https://fill.papermc.io/v3';
const FABRIC_META_BASE = process.env.MC_HOSTER_FABRIC_META_URL ?? 'https://meta.fabricmc.net/v2';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 хв — версії виходять не щохвилини
const FETCH_TIMEOUT_MS = 8000;

/**
 * Вбудований фолбек: список свідомо неповний (без мережі свіжі версії взяти
 * нізвідки), тому UI при source='fallback' показує підказку і дозволяє ввести
 * будь-яку версію вручну.
 */
const FALLBACK_GAME_VERSIONS = [
  '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1',
  '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.8',
];

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'mc-hoster (local panel)' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} від ${url}`);
  }
  return response.json();
}

export class VersionCatalog {
  private readonly cache = new Map<string, CacheEntry>();

  /** Кешована обгортка: один невдалий запит не кешуємо, щоб наступний спробував знову. */
  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T;
    }
    const value = await loader();
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  // ------------------------------------------------------------ версії гри

  /** Список версій гри, доступних для обраного ядра (новіші — першими). */
  async gameVersions(kind: ServerKind): Promise<VersionListResult> {
    try {
      switch (kind) {
        case 'PAPER':
          return { versions: await this.cached('paper:game', () => this.fetchPaperGameVersions()), source: 'online' };
        case 'FABRIC':
          return { versions: await this.cached('fabric:game', () => this.fetchFabricGameVersions()), source: 'online' };
        case 'VANILLA':
          return { versions: await this.cached('mojang:releases', () => this.fetchMojangReleases()), source: 'online' };
      }
    } catch {
      return { versions: FALLBACK_GAME_VERSIONS, source: 'fallback' };
    }
  }

  /** Mojang manifest: лише релізи, у порядку manifest'а (новіші — першими). */
  private async fetchMojangReleases(): Promise<string[]> {
    const data = (await fetchJson(MOJANG_MANIFEST_URL)) as {
      versions?: Array<{ id?: string; type?: string }>;
    };
    const releases = (data.versions ?? [])
      .filter((v) => v.type === 'release' && typeof v.id === 'string')
      .map((v) => v.id as string);
    if (releases.length === 0) throw new Error('Порожній manifest Mojang');
    return releases;
  }

  /**
   * Paper: версії гри. v2 повертає {versions: [...]} за зростанням;
   * Fill v3 — {versions: {"1.21": ["1.21.8", ...]}} згруповано. Приймаємо обидва.
   */
  private async fetchPaperGameVersions(): Promise<string[]> {
    const parse = (data: unknown): string[] => {
      const versions = (data as { versions?: unknown }).versions;
      if (Array.isArray(versions)) {
        return (versions as string[]).slice().reverse(); // v2: ascending → новіші першими
      }
      if (versions && typeof versions === 'object') {
        return Object.values(versions as Record<string, string[]>).flat();
      }
      throw new Error('Невідомий формат відповіді Paper');
    };
    try {
      return parse(await fetchJson(`${PAPER_V2_BASE}/projects/paper`));
    } catch {
      return parse(await fetchJson(`${PAPER_FILL_BASE}/projects/paper`));
    }
  }

  /** Fabric: стабільні версії гри (новіші — першими, як віддає meta). */
  private async fetchFabricGameVersions(): Promise<string[]> {
    const data = (await fetchJson(`${FABRIC_META_BASE}/versions/game`)) as Array<{
      version?: string;
      stable?: boolean;
    }>;
    const versions = data
      .filter((v) => v.stable === true && typeof v.version === 'string')
      .map((v) => v.version as string);
    if (versions.length === 0) throw new Error('Порожній список Fabric');
    return versions;
  }

  // ----------------------------------------------------------- версії ядра

  /**
   * Версії ядра ПІД конкретну версію гри:
   *  - PAPER  → номери білдів (новіші першими);
   *  - FABRIC → версії лоадера, сумісні з цією версією гри;
   *  - VANILLA → порожньо (окремого ядра немає).
   */
  async coreVersions(kind: ServerKind, gameVersion: string): Promise<CoreVersionsResult> {
    if (kind === 'VANILLA') {
      return { versions: [], latest: null, source: 'online' };
    }
    try {
      const versions =
        kind === 'PAPER'
          ? await this.cached(`paper:builds:${gameVersion}`, () => this.fetchPaperBuilds(gameVersion))
          : await this.cached(`fabric:loader:${gameVersion}`, () => this.fetchFabricLoaders(gameVersion));
      return { versions, latest: versions[0] ?? null, source: 'online' };
    } catch {
      // Без мережі конкретні білди невідомі — залишаємо «остання» (образ сам обере).
      return { versions: [], latest: null, source: 'fallback' };
    }
  }

  /** Paper: білди версії. v2 → {builds:[числа]}; Fill v3 → [{id}] або {builds:[{id}]}. */
  private async fetchPaperBuilds(gameVersion: string): Promise<string[]> {
    const encoded = encodeURIComponent(gameVersion);
    const parse = (data: unknown): string[] => {
      const raw = Array.isArray(data) ? data : (data as { builds?: unknown }).builds;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('Немає білдів');
      const ids = raw
        .map((item) => (typeof item === 'number' ? item : (item as { id?: number }).id))
        .filter((id): id is number => typeof id === 'number');
      if (ids.length === 0) throw new Error('Невідомий формат білдів Paper');
      return ids.sort((a, b) => b - a).map(String); // новіші першими
    };
    try {
      return parse(await fetchJson(`${PAPER_V2_BASE}/projects/paper/versions/${encoded}`));
    } catch {
      return parse(await fetchJson(`${PAPER_FILL_BASE}/projects/paper/versions/${encoded}/builds`));
    }
  }

  /** Fabric: версії лоадера, сумісні з версією гри (стабільні — першими). */
  private async fetchFabricLoaders(gameVersion: string): Promise<string[]> {
    const data = (await fetchJson(
      `${FABRIC_META_BASE}/versions/loader/${encodeURIComponent(gameVersion)}`,
    )) as Array<{ loader?: { version?: string; stable?: boolean } }>;
    const stable = data
      .filter((item) => item.loader?.stable === true && typeof item.loader.version === 'string')
      .map((item) => item.loader!.version as string);
    const any = data
      .map((item) => item.loader?.version)
      .filter((v): v is string => typeof v === 'string');
    const versions = stable.length > 0 ? stable : any;
    if (versions.length === 0) throw new Error('Немає лоадерів Fabric для цієї версії');
    return versions;
  }
}
