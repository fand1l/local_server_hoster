import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { toast } from '../toast';
import { BTN, withButtonLock } from '../ui';
import type { PlayerAction, PlayerInfo, PlayersResponse, ServerView } from '../types';

const REFRESH_INTERVAL_MS = 5000;

type Filter = 'all' | 'online' | 'whitelist' | 'ops' | 'bans';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'online', label: 'Онлайн' },
  { id: 'all', label: 'Усі відомі' },
  { id: 'whitelist', label: 'Whitelist' },
  { id: 'ops', label: 'Оператори' },
  { id: 'bans', label: 'Бани' },
];

/**
 * Вкладка «Гравці»: онлайн-список + відомі гравці з файлів сервера, з діями
 * kick/ban/op/whitelist. Голови скінів тягнуться з mc-heads.net за ніком —
 * лише для online-mode (в офлайні скінів/ліцензій немає, показуємо заглушку).
 *
 * Повертає cleanup, який зупиняє полінг (викликає сторінка сервера при зміні вкладки).
 */
export function renderPlayersPanel(
  root: HTMLElement,
  serverId: string,
  getServer: () => ServerView | null,
): () => void {
  let filter: Filter = 'online';
  let data: PlayersResponse | null = null;
  let loadError: string | null = null;

  function skinHead(player: PlayerInfo): HTMLElement {
    const onlineMode = getServer()?.onlineMode ?? true;
    if (onlineMode) {
      // mc-heads віддає голову скіна за ніком; помилку завантаження ловимо на fallback.
      const img = el('img', {
        class: 'size-8 shrink-0 rounded bg-zinc-800',
        // розмір голови 32px
        src: `https://mc-heads.net/avatar/${encodeURIComponent(player.name)}/32`,
      }) as HTMLImageElement;
      img.alt = player.name;
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.replaceWith(letterAvatar(player.name));
      });
      return img;
    }
    return letterAvatar(player.name);
  }

  /** Заглушка-аватар для офлайн-режиму: перша літера ніка на кольоровому тлі. */
  function letterAvatar(name: string): HTMLElement {
    const hue = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
    return el('span', {
      class: 'flex size-8 shrink-0 items-center justify-center rounded text-sm font-semibold text-white',
      // inline-стиль — колір із ніка (Tailwind не має довільних hue у класі без safelist)
      style: `background-color: hsl(${hue} 45% 40%)`,
      text: (name[0] ?? '?').toUpperCase(),
    });
  }

  function badge(text: string, cls: string): HTMLElement {
    return el('span', {
      class: `rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`,
      text,
    });
  }

  async function act(button: HTMLButtonElement, player: string, action: PlayerAction): Promise<void> {
    await withButtonLock(button, async () => {
      try {
        const result = await api.playerAction(serverId, player, action);
        toast(result.output || 'Виконано', result.confirmed ? 'success' : 'info');
        await refresh();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Дію не вдалося виконати', 'error');
      }
    });
  }

  function actionButton(label: string, cls: string, player: string, action: PlayerAction): HTMLElement {
    const button = el('button', { class: cls, text: label });
    button.addEventListener('click', () => void act(button as HTMLButtonElement, player, action));
    return button;
  }

  function playerRow(player: PlayerInfo): HTMLElement {
    const running = getServer()?.runtime === 'running';
    const smallBtn =
      'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset transition-colors ' +
      'disabled:opacity-40 disabled:cursor-not-allowed';

    // Набір дій залежить від поточного стану гравця.
    const actions: HTMLElement[] = [];
    if (running) {
      if (player.online) {
        actions.push(
          actionButton('Кік', `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`, player.name, 'kick'),
        );
      }
      actions.push(
        player.op
          ? actionButton('Зняти OP', `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`, player.name, 'deop')
          : actionButton('Дати OP', `${smallBtn} bg-amber-950/60 text-amber-300 ring-amber-900/60 hover:bg-amber-900/50`, player.name, 'op'),
      );
      actions.push(
        player.whitelisted
          ? actionButton('− WL', `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`, player.name, 'whitelist-remove')
          : actionButton('+ WL', `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`, player.name, 'whitelist-add'),
      );
      actions.push(
        player.banned
          ? actionButton('Розбан', `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`, player.name, 'pardon')
          : actionButton('Бан', `${smallBtn} bg-red-950/60 text-red-300 ring-red-900/60 hover:bg-red-900/50`, player.name, 'ban'),
      );
    }

    const tags: HTMLElement[] = [];
    if (player.online) tags.push(badge('онлайн', 'bg-emerald-950 text-emerald-400'));
    if (player.op) tags.push(badge('op', 'bg-amber-950 text-amber-400'));
    if (player.whitelisted) tags.push(badge('wl', 'bg-sky-950 text-sky-400'));
    if (player.banned) tags.push(badge('бан', 'bg-red-950 text-red-400'));

    return el(
      'div',
      { class: 'flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2' },
      skinHead(player),
      el(
        'div',
        { class: 'min-w-0 flex-1' },
        el(
          'div',
          { class: 'flex items-center gap-2' },
          el('span', { class: 'truncate text-sm font-medium text-zinc-100', text: player.name }),
          ...tags,
        ),
        player.uuid
          ? el('span', { class: 'block truncate text-[11px] text-zinc-600', text: player.uuid })
          : null,
      ),
      el('div', { class: 'flex shrink-0 flex-wrap items-center justify-end gap-1' }, ...actions),
    );
  }

  function applyFilter(players: PlayerInfo[]): PlayerInfo[] {
    switch (filter) {
      case 'online':
        return players.filter((p) => p.online);
      case 'whitelist':
        return players.filter((p) => p.whitelisted);
      case 'ops':
        return players.filter((p) => p.op);
      case 'bans':
        return players.filter((p) => p.banned);
      default:
        return players;
    }
  }

  function render(): void {
    const server = getServer();

    const filterRow = el(
      'div',
      { class: 'flex flex-wrap gap-1.5' },
      ...FILTERS.map(({ id, label }) => {
        const active = filter === id;
        const count =
          data &&
          {
            online: data.onlineCount,
            all: data.players.length,
            whitelist: data.players.filter((p) => p.whitelisted).length,
            ops: data.players.filter((p) => p.op).length,
            bans: data.players.filter((p) => p.banned).length,
          }[id];
        const button = el('button', {
          class:
            'rounded-lg px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ' +
            (active
              ? 'bg-emerald-600 text-white ring-emerald-500'
              : 'bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200'),
          text: count !== null && count !== undefined ? `${label} (${count})` : label,
        });
        button.addEventListener('click', () => {
          filter = id;
          render();
        });
        return button;
      }),
    );

    const children: (HTMLElement | null)[] = [filterRow];

    if (server && server.runtime !== 'running') {
      children.push(
        el('p', {
          class: 'rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400',
          text: 'Сервер зупинено — показані відомі гравці з файлів. Дії доступні на запущеному сервері.',
        }),
      );
    }
    if (data?.warning) {
      children.push(
        el('p', {
          class: 'rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300',
          text: data.warning,
        }),
      );
    }
    if (loadError) {
      children.push(el('p', { class: 'text-sm text-red-400', text: loadError }));
    }

    if (data) {
      const list = applyFilter(data.players);
      if (list.length === 0) {
        children.push(
          el('p', {
            class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-8 text-center text-sm text-zinc-500',
            text:
              filter === 'online'
                ? 'Зараз онлайн нікого немає.'
                : 'Порожньо. Гравці з’являться тут після першого входу на сервер.',
          }),
        );
      } else {
        children.push(el('div', { class: 'space-y-2' }, ...list.map(playerRow)));
      }
    } else if (!loadError) {
      children.push(el('p', { class: 'text-sm text-zinc-500', text: 'Завантаження…' }));
    }

    mount(root, el('div', { class: 'space-y-3' }, ...children));
  }

  async function refresh(): Promise<void> {
    try {
      data = await api.listPlayers(serverId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : 'Не вдалося завантажити гравців';
    }
    render();
  }

  render();
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}
