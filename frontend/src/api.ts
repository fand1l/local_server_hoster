import type {
  AddonInfo,
  AddonsResponse,
  DirListing,
  FileEntry,
  FileTextContent,
  CoreVersionsResult,
  CreateServerInput,
  PlayerAction,
  PlayersResponse,
  PregenAvailability,
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
  // Content-Type ставимо ЛИШЕ коли є JSON-тіло: заголовок на порожньому POST
  // (start/stop/restart) сервер справедливо вважає некоректним запитом, а для
  // FormData браузер сам виставить multipart із boundary — не чіпаємо.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
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
  metaPregen: (kind: ServerKind, version: string) =>
    request<PregenAvailability>(
      `/api/meta/pregen?kind=${kind}&version=${encodeURIComponent(version)}`,
    ),

  listPlayers: (id: string) => request<PlayersResponse>(`/api/servers/${id}/players`),
  playerAction: (id: string, player: string, action: PlayerAction) =>
    request<{ output: string; confirmed: boolean }>(`/api/servers/${id}/players/action`, {
      method: 'POST',
      body: JSON.stringify({ player, action }),
    }),

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

  listAddons: (id: string) => request<AddonsResponse>(`/api/servers/${id}/addons`),
  uploadAddon: (id: string, file: File) => {
    // FormData сам ставить multipart Content-Type із boundary — заголовок не задаємо.
    const form = new FormData();
    form.append('file', file, file.name);
    return request<AddonInfo>(`/api/servers/${id}/addons`, { method: 'POST', body: form });
  },
  deleteAddon: (id: string, filename: string) =>
    request<void>(`/api/servers/${id}/addons/${encodeURIComponent(filename)}`, { method: 'DELETE' }),

  // --- Файловий менеджер ---
  listFiles: (id: string, path: string) =>
    request<DirListing>(`/api/servers/${id}/files?path=${encodeURIComponent(path)}`),
  readFile: (id: string, path: string) =>
    request<FileTextContent>(`/api/servers/${id}/files/content?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    request<FileTextContent>(`/api/servers/${id}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  uploadFile: (id: string, dir: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<FileEntry>(`/api/servers/${id}/files/upload?path=${encodeURIComponent(dir)}`, {
      method: 'POST',
      body: form,
    });
  },
  makeDir: (id: string, dir: string, name: string) =>
    request<FileEntry>(`/api/servers/${id}/files/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: dir, name }),
    }),
  renameFile: (id: string, path: string, newName: string) =>
    request<FileEntry>(`/api/servers/${id}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ path, newName }),
    }),
  deleteFile: (id: string, path: string) =>
    request<void>(`/api/servers/${id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  /** URL для завантаження файлу (пряме посилання, віддається браузером). */
  downloadFileUrl: (id: string, path: string) =>
    `/api/servers/${id}/files/download?path=${encodeURIComponent(path)}`,

  getProperties: (id: string) => request<PropertiesResponse>(`/api/servers/${id}/properties`),
  saveProperties: (id: string, entries: PropertyEntry[]) =>
    request<PropertiesResponse>(`/api/servers/${id}/properties`, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
};
