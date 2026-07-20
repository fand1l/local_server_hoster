import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { openCreateServerModal, openDeleteServerModal } from '../modals';
import { toast } from '../toast';
import { BTN, chip, coreVersionChipText, formatMemory, KIND_LABELS, statusBadge, withButtonLock } from '../ui';
import type { ServerView } from '../types';

const REFRESH_INTERVAL_MS = 3000;
const DEFAULT_MINECRAFT_PORT = 25565;

/**
 * Головна сторінка: сітка карток серверів + кнопка створення.
 * Список оновлюється полінгом; повертає cleanup для роутера.
 */
export function renderDashboard(root: HTMLElement): () => void {
  let servers: ServerView[] = [];
  let loadFailed = false;

  const grid = el('div', { class: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' });

  const createButton = el('button', {
    class: BTN.primary,
    text: '+ Створити сервер',
    onClick: () => openCreateServerModal(suggestPort(), () => void refresh()),
  });

  const header = el(
    'div',
    { class: 'mb-6 flex flex-wrap items-center justify-between gap-3' },
    el(
      'div',
      {},
      el('h1', { class: 'text-xl font-semibold text-zinc-100', text: 'Мої сервери' }),
      el('p', {
        class: 'text-sm text-zinc-500',
        text: 'Кожен сервер працює в ізольованому Docker-контейнері',
      }),
    ),
    createButton,
  );

  mount(root, header, grid);

  /** Пропонуємо перший вільний порт, починаючи зі стандартного 25565. */
  function suggestPort(): number {
    const taken = new Set(servers.map((server) => server.hostPort));
    let port = DEFAULT_MINECRAFT_PORT;
    while (taken.has(port)) port += 1;
    return port;
  }

  function renderGrid(): void {
    if (loadFailed) {
      mount(
        grid,
        el('p', {
          class: 'col-span-full rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300',
          text: 'Не вдалося завантажити список серверів. Перевірте, що бекенд панелі запущено.',
        }),
      );
      return;
    }
    if (servers.length === 0) {
      mount(
        grid,
        el(
          'div',
          {
            class:
              'col-span-full rounded-xl border border-dashed border-zinc-800 p-10 text-center text-zinc-500',
          },
          el('p', { class: 'mb-1 text-3xl', text: '⛏️' }),
          el('p', { text: 'Серверів ще немає. Створіть перший — це кілька кліків.' }),
        ),
      );
      return;
    }
    mount(grid, ...servers.map(serverCard));
  }

  function serverCard(server: ServerView): HTMLElement {
    const startButton = el('button', { class: BTN.primary, text: 'Запустити' });
    const stopButton = el('button', { class: BTN.neutral, text: 'Зупинити' });
    const restartButton = el('button', { class: BTN.neutral, text: 'Рестарт' });
    const deleteButton = el('button', { class: BTN.danger, text: 'Видалити', title: 'Видалити сервер' });

    startButton.disabled = !(server.runtime === 'stopped' || server.runtime === 'error');
    stopButton.disabled = server.runtime !== 'running';
    restartButton.disabled = server.runtime !== 'running';
    deleteButton.disabled = server.runtime === 'creating';

    startButton.addEventListener('click', () =>
      withButtonLock(startButton, () => lifecycleAction(() => api.startServer(server.id))),
    );
    stopButton.addEventListener('click', () =>
      withButtonLock(stopButton, () => lifecycleAction(() => api.stopServer(server.id))),
    );
    restartButton.addEventListener('click', () =>
      withButtonLock(restartButton, () => lifecycleAction(() => api.restartServer(server.id))),
    );
    deleteButton.addEventListener('click', () =>
      openDeleteServerModal(server, () => void refresh()),
    );

    const detailText = server.runtimeDetail ?? server.statusDetail;

    return el(
      'div',
      { class: 'flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4' },
      el(
        'div',
        { class: 'flex items-start justify-between gap-2' },
        el('a', {
          class: 'text-base font-semibold text-zinc-100 hover:text-emerald-400 transition-colors',
          text: server.name,
          href: `#/server/${server.id}`,
        }),
        statusBadge(server),
      ),
      el(
        'div',
        { class: 'flex flex-wrap gap-1.5' },
        chip(KIND_LABELS[server.kind]),
        chip(server.version, 'Версія Minecraft'),
        server.coreVersion
          ? chip(coreVersionChipText(server.kind, server.coreVersion), 'Версія ядра')
          : null,
        chip(`:${server.hostPort}`, 'Порт для гравців'),
        chip(formatMemory(server.memoryMb), 'Пам’ять JVM'),
        server.cpuCores ? chip(`${server.cpuCores} CPU`, 'Ліміт CPU') : null,
      ),
      detailText
        ? el('p', { class: 'text-xs text-zinc-500 break-words', text: detailText })
        : null,
      el(
        'div',
        { class: 'mt-auto flex flex-wrap gap-2 pt-1' },
        startButton,
        stopButton,
        restartButton,
        el('a', { class: BTN.neutral, text: 'Консоль', href: `#/server/${server.id}` }),
        deleteButton,
      ),
    );
  }

  async function lifecycleAction(action: () => Promise<ServerView>): Promise<void> {
    try {
      await action();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Операція не вдалася', 'error');
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    try {
      servers = await api.listServers();
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
    renderGrid();
  }

  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}
