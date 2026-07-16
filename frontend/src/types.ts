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
  hostPort: number;
  memoryMb: number;
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
  hostPort: number;
  memoryMb: number;
  acceptEula: true;
  autoStart: boolean;
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
}

export type ConsoleServerMessage =
  | { type: 'log'; data: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'status'; runtime: RuntimeStatus };

export type ConsoleClientMessage = { type: 'command'; data: string };
