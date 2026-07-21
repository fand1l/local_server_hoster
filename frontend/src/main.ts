import './styles.css';
import { api } from './api';
import { el, mount, replayAnim } from './dom';
import { renderDashboard } from './views/dashboard';
import { renderServerDetail } from './views/serverDetail';

/**
 * Точка входу SPA: каркас сторінки, hash-роутер і банер стану Docker.
 * Маршрути: #/ — дашборд, #/server/<id> — сторінка сервера.
 */

const SYSTEM_POLL_INTERVAL_MS = 8000;

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('Не знайдено #app у index.html');

// --------------------------------------------------------------------- шапка

const dockerPill = el('span', {
  class: 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ring-1 ring-inset',
  text: 'Docker: перевірка…',
});

const dockerBanner = el('div', {
  class:
    'hidden border-b border-red-900/60 bg-red-950/60 px-4 py-2 text-center text-sm text-red-200',
  text:
    'Docker-демон недоступний. Запустіть Docker Desktop (Windows/macOS) або dockerd (Linux) — ' +
    'без нього неможливо керувати серверами.',
});

function setDockerState(state: 'ok' | 'down' | 'checking', version?: string | null): void {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ring-1 ring-inset ';
  if (state === 'ok') {
    dockerPill.className = base + 'bg-emerald-950/60 text-emerald-300 ring-emerald-800/60';
    dockerPill.textContent = `Docker: онлайн${version ? ` (v${version})` : ''}`;
    dockerBanner.classList.add('hidden');
  } else if (state === 'down') {
    dockerPill.className = base + 'bg-red-950/60 text-red-300 ring-red-800/60';
    dockerPill.textContent = 'Docker: офлайн';
    dockerBanner.classList.remove('hidden');
  } else {
    dockerPill.className = base + 'bg-zinc-900 text-zinc-400 ring-zinc-700/60';
    dockerPill.textContent = 'Docker: перевірка…';
  }
}

async function pollSystem(): Promise<void> {
  try {
    const info = await api.system();
    setDockerState(info.dockerAvailable ? 'ok' : 'down', info.dockerVersion);
  } catch {
    // Бекенд недоступний — показуємо як "офлайн", детальніше скаже дашборд.
    setDockerState('down');
  }
}

const header = el(
  'header',
  { class: 'border-b border-zinc-800 bg-zinc-950/95 sticky top-0 z-30 backdrop-blur' },
  el(
    'div',
    { class: 'mx-auto flex max-w-6xl items-center justify-between px-4 py-3' },
    el(
      'a',
      { class: 'flex items-center gap-2', href: '#/' },
      el('span', { class: 'text-xl', text: '⛏️' }),
      el('span', { class: 'font-semibold tracking-tight text-zinc-100', text: 'MC Hoster' }),
      el('span', { class: 'hidden text-xs text-zinc-600 sm:inline', text: 'локальна панель Minecraft-серверів' }),
    ),
    dockerPill,
  ),
);

const viewRoot = el('main', { class: 'mx-auto w-full max-w-6xl flex-1 px-4 py-6' });
mount(appRoot, header, dockerBanner, viewRoot);

// -------------------------------------------------------------------- роутер

type Route = { view: 'dashboard' } | { view: 'server'; id: string };

function parseRoute(): Route {
  const hash = location.hash || '#/';
  const serverMatch = /^#\/server\/([A-Za-z0-9-]+)$/.exec(hash);
  if (serverMatch?.[1]) return { view: 'server', id: serverMatch[1] };
  return { view: 'dashboard' };
}

let cleanupView: (() => void) | null = null;

function renderRoute(): void {
  cleanupView?.();
  const route = parseRoute();
  cleanupView =
    route.view === 'server'
      ? renderServerDetail(viewRoot, route.id)
      : renderDashboard(viewRoot);
  // Швидка поява при переході між сторінками (дашборд ↔ сервер).
  replayAnim(viewRoot, 'anim-fade');
}

window.addEventListener('hashchange', renderRoute);

// ---------------------------------------------------------------------- старт

setDockerState('checking');
void pollSystem();
setInterval(() => void pollSystem(), SYSTEM_POLL_INTERVAL_MS);
renderRoute();
