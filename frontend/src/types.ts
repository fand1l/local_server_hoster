/**
 * DTO-типи API — дзеркало backend/src/types.ts.
 * Змінюючи бекенд, синхронізуйте цей файл.
 */

export const SERVER_KINDS = ['PAPER', 'VANILLA', 'FABRIC', 'SPIGOT', 'FORGE', 'NEOFORGE'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export type ProvisionStatus = 'provisioning' | 'ready' | 'error';
export type RuntimeStatus = 'creating' | 'running' | 'stopped' | 'error' | 'unknown';

export interface PregenProgress {
  state: 'running' | 'finished' | 'cancelled';
  percent: number;
  processedChunks: number;
  etaSeconds: number | null;
  rate: number | null;
  updatedAt: string;
}

export interface ServerView {
  id: string;
  name: string;
  kind: ServerKind;
  version: string;
  /** Версія ядра: білд Paper / лоадер Fabric; null = остання. */
  coreVersion: string | null;
  hostPort: number;
  memoryMb: number;
  /** Ліміт CPU у ядрах; null = без ліміту. */
  cpuCores: number | null;
  onlineMode: boolean;
  pregenRadius: number | null;
  pregenDone: boolean;
  dataDir: string;
  containerId: string | null;
  status: ProvisionStatus;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
  runtime: RuntimeStatus;
  runtimeDetail: string | null;
  pregenProgress: PregenProgress | null;
}

export interface CreateServerInput {
  name: string;
  kind: ServerKind;
  version: string;
  coreVersion?: string;
  hostPort: number;
  memoryMb: number;
  cpuCores?: number;
  onlineMode: boolean;
  pregenRadius?: number;
  acceptEula: true;
  autoStart: boolean;
}

export type PlayerAction =
  | 'kick'
  | 'ban'
  | 'pardon'
  | 'op'
  | 'deop'
  | 'whitelist-add'
  | 'whitelist-remove';

export interface PlayerInfo {
  name: string;
  uuid: string | null;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}

export interface PlayersResponse {
  players: PlayerInfo[];
  onlineCount: number;
  rconAvailable: boolean;
  whitelistEnabled: boolean;
  warning: string | null;
}

export interface PregenAvailability {
  available: boolean;
  reason: string | null;
}

export type FileEntryType = 'file' | 'directory';
export interface FileEntry {
  name: string;
  type: FileEntryType;
  sizeBytes: number;
  modifiedAt: string;
}
export interface DirListing {
  path: string;
  entries: FileEntry[];
}
export interface FileTextContent {
  path: string;
  content: string;
}

export type AddonCategory = 'plugins' | 'mods';

export interface AddonInfo {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface AddonsResponse {
  supported: boolean;
  category: AddonCategory | null;
  addons: AddonInfo[];
  requiresRestart: boolean;
  warning: string | null;
}

/** Результат пошуку контенту на Modrinth. */
export interface AddonSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
}

export interface AddonSearchResponse {
  hits: AddonSearchHit[];
  total: number;
  offset: number;
  category: AddonCategory;
  source: 'online' | 'offline';
}

/** Поля, які можна змінити після створення (PATCH /api/servers/:id). */
export interface UpdateServerInput {
  name?: string;
  memoryMb?: number;
  cpuCores?: number | null;
  hostPort?: number;
}

export interface VersionListResult {
  versions: string[];
  /** 'fallback' = вбудований неповний список (немає мережі) — дозволяємо ручний ввід. */
  source: 'online' | 'fallback';
}

export interface CoreVersionsResult extends VersionListResult {
  latest: string | null;
}

export interface PropertyEntry {
  key: string;
  value: string;
}

export interface PropertiesResponse {
  exists: boolean;
  entries: PropertyEntry[];
  warning: string | null;
}

export interface SystemInfo {
  dockerAvailable: boolean;
  dockerVersion: string | null;
  /** Фізична пам'ять машини у МБ (межа повзунка ОЗП у майстрі). */
  totalMemoryMb: number;
  /** Логічні ядра CPU (межа повзунка ЦП у майстрі). */
  cpuCount: number;
}

export type ConsoleServerMessage =
  | { type: 'log'; data: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'status'; runtime: RuntimeStatus }
  | { type: 'pregen'; progress: PregenProgress | null };

export type ConsoleClientMessage = { type: 'command'; data: string };
