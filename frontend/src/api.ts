import type {
  CreateServerInput,
  PropertiesResponse,
  PropertyEntry,
  ServerView,
  SystemInfo,
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
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
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

  listServers: () => request<ServerView[]>('/api/servers'),
  getServer: (id: string) => request<ServerView>(`/api/servers/${id}`),
  createServer: (input: CreateServerInput) =>
    request<ServerView>('/api/servers', { method: 'POST', body: JSON.stringify(input) }),
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
