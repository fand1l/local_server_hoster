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
const FORGE_METADATA_URL =
  process.env.MC_HOSTER_FORGE_META_URL ??
  'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const NEOFORGE_VERSIONS_URL =
  process.env.MC_HOSTER_NEOFORGE_META_URL ??
  'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const MODRINTH_BASE = process.env.MC_HOSTER_MODRINTH_URL ?? 'https://api.modrinth.com/v2';
/** Slug проєкту Chunky на Modrinth (прегенератор чанків). */
const CHUNKY_PROJECT = 'chunky';

/**
 * Наше ядро → лоадер у термінах Modrinth. Vanilla не має завантажувача модів,
 * тож для нього Chunky (як і будь-який плагін/мод) недоступний у принципі.
 */
const MODRINTH_LOADER: Partial<Record<ServerKind, string>> = {
  PAPER: 'paper',
  SPIGOT: 'spigot',
  FABRIC: 'fabric',
  FORGE: 'forge',
  NEOFORGE: 'neoforge',
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 хв — версії виходять не щохвилини
const FETCH_TIMEOUT_MS = 8000;

/**
 * Вбудований фолбек: список свідомо неповний (без мережі свіжі версії взяти
 * нізвідки), тому UI при source='fallback' показує підказку і дозволяє ввести
 * будь-яку версію вручну.
 */
// Порядок — від найновіших. Врахована нова рік-орієнтована схема Mojang
// ("26.2", "26.1", …), що йде після 1.21.x.
const FALLBACK_GAME_VERSIONS = [
  '26.2', '26.1',
  '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.5', '1.21.4', '1.21.1', '1.21',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1',
  '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.8',
];

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/**
 * Порівняння версій "за здоровим глуздом" для сортування за спаданням:
 * числові сегменти — як числа, текстові суфікси (beta/rc) — після релізів.
 */
function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string) => v.split(/[.-]/);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const [sa, sb] = [pa[i], pb[i]];
    if (sa === undefined) return 1; // коротша (без суфікса) — новіша
    if (sb === undefined) return -1;
    const [na, nb] = [Number(sa), Number(sb)];
    const [aNum, bNum] = [Number.isInteger(na), Number.isInteger(nb)];
    if (aNum && bNum && na !== nb) return nb - na;
    if (aNum !== bNum) return aNum ? -1 : 1; // число "новіше" за текстовий суфікс
    if (!aNum && !bNum && sa !== sb) return sb.localeCompare(sa);
  }
  return 0;
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
        // Spigot збирається під ті самі версії, що й vanilla, а окремого
        // публічного API версій у нього немає — використовуємо список Mojang.
        case 'VANILLA':
        case 'SPIGOT':
          return { versions: await this.cached('mojang:releases', () => this.fetchMojangReleases()), source: 'online' };
        case 'FORGE':
          return { versions: await this.cached('forge:game', () => this.fetchForgeGameVersions()), source: 'online' };
        case 'NEOFORGE':
          return { versions: await this.cached('neoforge:game', () => this.fetchNeoForgeGameVersions()), source: 'online' };
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

  /**
   * Сирі дані Forge: maven-metadata.json має форму
   * { "1.21.1": ["1.21.1-52.0.1", …], … } — версія гри → повні версії Forge.
   */
  private async fetchForgeMetadata(): Promise<Record<string, string[]>> {
    return this.cached('forge:metadata', async () => {
      const data = (await fetchJson(FORGE_METADATA_URL)) as Record<string, unknown>;
      const result: Record<string, string[]> = {};
      for (const [game, list] of Object.entries(data)) {
        if (Array.isArray(list)) {
          result[game] = list.filter((v): v is string => typeof v === 'string');
        }
      }
      if (Object.keys(result).length === 0) throw new Error('Порожні метадані Forge');
      return result;
    });
  }

  /** Forge: версії гри = ключі метаданих, упорядковані за manifest'ом Mojang. */
  private async fetchForgeGameVersions(): Promise<string[]> {
    const metadata = await this.fetchForgeMetadata();
    return this.orderByMojang(Object.keys(metadata));
  }

  /** Сирі дані NeoForge: { versions: ["21.1.115", "20.6.72-beta", …] }. */
  private async fetchNeoForgeVersions(): Promise<string[]> {
    return this.cached('neoforge:versions', async () => {
      const data = (await fetchJson(NEOFORGE_VERSIONS_URL)) as { versions?: unknown };
      const versions = Array.isArray(data.versions)
        ? data.versions.filter((v): v is string => typeof v === 'string')
        : [];
      if (versions.length === 0) throw new Error('Порожній список NeoForge');
      return versions;
    });
  }

  /**
   * NeoForge нумерується як <mcMinor>.<mcPatch>.<build> (напр. 21.1.115 ↔ MC 1.21.1),
   * тож версію гри відновлюємо з двох перших сегментів, звіряючись зі списком Mojang
   * (пробуємо і "1.a.b", і "a.b", і "1.a" — це покриває й нові схеми нумерації MC).
   */
  private async neoForgeGameVersionOf(neoVersion: string, releases: Set<string>): Promise<string | null> {
    const match = /^(\d+)\.(\d+)\./.exec(neoVersion);
    if (!match) return null;
    const [a, b] = [match[1], match[2]];
    const candidates = b === '0' ? [`1.${a}`, `${a}.0`, `1.${a}.${b}`] : [`1.${a}.${b}`, `${a}.${b}`];
    for (const candidate of candidates) {
      if (releases.has(candidate)) return candidate;
    }
    return null;
  }

  /** NeoForge: версії гри, для яких існують збірки (порядок — за Mojang). */
  private async fetchNeoForgeGameVersions(): Promise<string[]> {
    const [neoVersions, releases] = await Promise.all([
      this.fetchNeoForgeVersions(),
      this.cached('mojang:releases', () => this.fetchMojangReleases()),
    ]);
    const releaseSet = new Set(releases);
    const found = new Set<string>();
    for (const neoVersion of neoVersions) {
      const game = await this.neoForgeGameVersionOf(neoVersion, releaseSet);
      if (game) found.add(game);
    }
    if (found.size === 0) throw new Error('Не вдалося зіставити версії NeoForge з версіями гри');
    return releases.filter((release) => found.has(release));
  }

  // ------------------------------------------------------------- Chunky

  /**
   * Чи доступний прегенератор Chunky для цього ядра+версії гри.
   * Питаємо Modrinth, чи існує версія Chunky під відповідний лоадер і версію
   * гри. Vanilla не має завантажувача модів → одразу false без запиту.
   */
  async chunkyAvailability(
    kind: ServerKind,
    gameVersion: string,
  ): Promise<{ available: boolean; reason: string | null }> {
    const loader = MODRINTH_LOADER[kind];
    if (!loader) {
      return {
        available: false,
        reason: 'Vanilla не підтримує плагіни/моди — прегенерація Chunky недоступна. Оберіть Paper, Fabric, Forge або NeoForge.',
      };
    }
    try {
      const versions = await this.cached(`chunky:${loader}:${gameVersion}`, async () => {
        const query =
          `?loaders=${encodeURIComponent(JSON.stringify([loader]))}` +
          `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
        const data = (await fetchJson(
          `${MODRINTH_BASE}/project/${CHUNKY_PROJECT}/version${query}`,
        )) as unknown[];
        return Array.isArray(data) ? data.length : 0;
      });
      return versions > 0
        ? { available: true, reason: null }
        : {
            available: false,
            reason: `Для ${gameVersion} (${kind}) немає сумісної збірки Chunky — спробуйте іншу версію гри.`,
          };
    } catch {
      // Modrinth недоступний — не блокуємо створення, але й не обіцяємо прегенерацію.
      return { available: false, reason: 'Не вдалося перевірити доступність Chunky (немає з’єднання).' };
    }
  }

  /** Упорядковує список версій гри за порядком manifest'а Mojang (новіші першими). */
  private async orderByMojang(versions: string[]): Promise<string[]> {
    const set = new Set(versions);
    try {
      const releases = await this.cached('mojang:releases', () => this.fetchMojangReleases());
      const ordered = releases.filter((release) => set.has(release));
      // Версії, яких немає у manifest (екзотика типу "1.7.10_pre4"), не показуємо.
      if (ordered.length > 0) return ordered;
    } catch {
      // Mojang недоступний — впорядкуємо самі.
    }
    return versions.sort(compareVersionsDesc);
  }

  // ----------------------------------------------------------- версії ядра

  /**
   * Версії ядра ПІД конкретну версію гри:
   *  - PAPER    → номери білдів (новіші першими);
   *  - FABRIC   → версії лоадера, сумісні з цією версією гри;
   *  - FORGE    → версії Forge для цієї версії гри (без префікса "1.x.y-");
   *  - NEOFORGE → версії NeoForge, чиї перші сегменти відповідають версії гри;
   *  - VANILLA / SPIGOT → порожньо (окремої версії ядра немає).
   */
  async coreVersions(kind: ServerKind, gameVersion: string): Promise<CoreVersionsResult> {
    if (kind === 'VANILLA' || kind === 'SPIGOT') {
      return { versions: [], latest: null, source: 'online' };
    }
    try {
      let versions: string[];
      switch (kind) {
        case 'PAPER':
          versions = await this.cached(`paper:builds:${gameVersion}`, () => this.fetchPaperBuilds(gameVersion));
          break;
        case 'FABRIC':
          versions = await this.cached(`fabric:loader:${gameVersion}`, () => this.fetchFabricLoaders(gameVersion));
          break;
        case 'FORGE':
          versions = await this.fetchForgeVersionsFor(gameVersion);
          break;
        case 'NEOFORGE':
          versions = await this.fetchNeoForgeVersionsFor(gameVersion);
          break;
      }
      return { versions, latest: versions[0] ?? null, source: 'online' };
    } catch {
      // Без мережі конкретні білди невідомі — залишаємо «остання» (образ сам обере).
      return { versions: [], latest: null, source: 'fallback' };
    }
  }

  /** Forge: "1.21.1-52.0.31" → "52.0.31" (env FORGE_VERSION приймає саме такий вигляд). */
  private async fetchForgeVersionsFor(gameVersion: string): Promise<string[]> {
    const metadata = await this.fetchForgeMetadata();
    const full = metadata[gameVersion] ?? [];
    if (full.length === 0) throw new Error(`Немає збірок Forge для ${gameVersion}`);
    const prefix = `${gameVersion}-`;
    return full
      .map((v) => (v.startsWith(prefix) ? v.slice(prefix.length) : v))
      .reverse(); // maven-metadata за зростанням → новіші першими
  }

  /** NeoForge: усі версії, що відповідають цій версії гри (новіші першими). */
  private async fetchNeoForgeVersionsFor(gameVersion: string): Promise<string[]> {
    const [neoVersions, releases] = await Promise.all([
      this.fetchNeoForgeVersions(),
      this.cached('mojang:releases', () => this.fetchMojangReleases()).catch(() => [gameVersion]),
    ]);
    const releaseSet = new Set(releases.length > 0 ? releases : [gameVersion]);
    const matching: string[] = [];
    for (const neoVersion of neoVersions) {
      if ((await this.neoForgeGameVersionOf(neoVersion, releaseSet)) === gameVersion) {
        matching.push(neoVersion);
      }
    }
    if (matching.length === 0) throw new Error(`Немає збірок NeoForge для ${gameVersion}`);
    return matching.sort(compareVersionsDesc);
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
