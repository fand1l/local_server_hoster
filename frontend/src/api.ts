import type {
  CoreVersionsResult,
  CreateServerInput,
  PropertiesResponse,
  PropertyEntry,
  ServerKind,
  ServerView,
  SystemInfo,
  UpdateServerInput,
  VersionListResult,
} from './types';

/** Помилка API з людиночитним повідомленням від бекенду. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type ставимо ЛИШЕ коли реально є тіло: заголовок на порожньому
  // POST (start/stop/restart) сервер справедливо вважає некоректним запитом.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('Немає з’єднання з панеллю (бекенд не запущено?)', 0, 'NETWORK');
  }

  if (res.status === 204) return undefined as T;

  const body = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!res.ok) {
    const message = body?.error?.message ?? `Помилка HTTP ${res.status}`;
    throw new ApiError(message, res.status, body?.error?.code ?? null);
  }
  return body as T;
}

/** Типізований клієнт REST API панелі. */
export const api = {
  system: () => request<SystemInfo>('/api/system'),

  metaVersions: (kind: ServerKind) =>
    request<VersionListResult>(`/api/meta/versions?kind=${kind}`),
  metaCoreVersions: (kind: ServerKind, version: string) =>
    request<CoreVersionsResult>(
      `/api/meta/core-versions?kind=${kind}&version=${encodeURIComponent(version)}`,
    ),

  listServers: () => request<ServerView[]>('/api/servers'),
  getServer: (id: string) => request<ServerView>(`/api/servers/${id}`),
  createServer: (input: CreateServerInput) =>
    request<ServerView>('/api/servers', { method: 'POST', body: JSON.stringify(input) }),
  updateServer: (id: string, patch: UpdateServerInput) =>
    request<ServerView>(`/api/servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteServer: (id: string, deleteData: boolean) =>
    request<void>(`/api/servers/${id}?deleteData=${deleteData}`, { method: 'DELETE' }),

  startServer: (id: string) => request<ServerView>(`/api/servers/${id}/start`, { method: 'POST' }),
  stopServer: (id: string) => request<ServerView>(`/api/servers/${id}/stop`, { method: 'POST' }),
  restartServer: (id: string) =>
    request<ServerView>(`/api/servers/${id}/restart`, { method: 'POST' }),

  getProperties: (id: string) => request<PropertiesResponse>(`/api/servers/${id}/properties`),
  saveProperties: (id: string, entries: PropertyEntry[]) =>
    request<PropertiesResponse>(`/api/servers/${id}/properties`, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
};
