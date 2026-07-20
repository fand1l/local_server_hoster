/**
 * DTO-типи API — дзеркало backend/src/types.ts.
 * Змінюючи бекенд, синхронізуйте цей файл.
 */

export const SERVER_KINDS = ['VANILLA', 'PAPER', 'FABRIC'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export type ProvisionStatus = 'provisioning' | 'ready' | 'error';
export type RuntimeStatus = 'creating' | 'running' | 'stopped' | 'error' | 'unknown';

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
  dataDir: string;
  containerId: string | null;
  status: ProvisionStatus;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
  runtime: RuntimeStatus;
  runtimeDetail: string | null;
}

export interface CreateServerInput {
  name: string;
  kind: ServerKind;
  version: string;
  coreVersion?: string;
  hostPort: number;
  memoryMb: number;
  cpuCores?: number;
  acceptEula: true;
  autoStart: boolean;
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
  | { type: 'status'; runtime: RuntimeStatus };

export type ConsoleClientMessage = { type: 'command'; data: string };
