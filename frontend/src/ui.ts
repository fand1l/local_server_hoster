import { el } from './dom';
import type { PregenProgress, RuntimeStatus, ServerKind, ServerView } from './types';

/** Підписи та кольори зведених станів сервера. */
export const RUNTIME_LABELS: Record<RuntimeStatus, string> = {
  creating: 'Створюється…',
  running: 'Працює',
  stopped: 'Зупинено',
  error: 'Помилка',
  unknown: 'Невідомо',
};

const RUNTIME_DOT_CLASSES: Record<RuntimeStatus, string> = {
  creating: 'bg-amber-400 animate-pulse',
  running: 'bg-emerald-400',
  stopped: 'bg-zinc-500',
  error: 'bg-red-500',
  unknown: 'bg-zinc-600',
};

export const KIND_LABELS: Record<ServerKind, string> = {
  PAPER: 'Paper',
  VANILLA: 'Vanilla',
  FABRIC: 'Fabric',
  SPIGOT: 'Spigot',
  FORGE: 'Forge',
  NEOFORGE: 'NeoForge',
};

/** Категорія доповнень ядра: плагіни (Paper/Spigot), моди (Fabric/Forge/NeoForge) або немає (Vanilla). */
export function addonCategoryFor(kind: ServerKind): 'plugins' | 'mods' | null {
  if (kind === 'VANILLA') return null;
  return kind === 'PAPER' || kind === 'SPIGOT' ? 'plugins' : 'mods';
}

/** Підпис вкладки доповнень для ядра ("Плагіни"/"Моди") або null для Vanilla. */
export function addonTabLabel(kind: ServerKind): string | null {
  const category = addonCategoryFor(kind);
  return category === 'plugins' ? 'Плагіни' : category === 'mods' ? 'Моди' : null;
}

/** Бейдж стану: кольорова крапка + підпис; деталі — у title. */
export function statusBadge(server: ServerView): HTMLElement {
  return el(
    'span',
    {
      class: 'inline-flex items-center gap-1.5 text-sm text-zinc-300',
      title: server.runtimeDetail ?? '',
    },
    el('span', { class: `size-2 rounded-full ${RUNTIME_DOT_CLASSES[server.runtime]}` }),
    RUNTIME_LABELS[server.runtime],
  );
}

/** Маленький сірий чіп із фактом про сервер (версія, порт тощо). */
export function chip(text: string, title?: string): HTMLElement {
  return el('span', {
    class:
      'inline-flex items-center rounded-md bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-300 ' +
      'ring-1 ring-inset ring-zinc-700/60',
    text,
    title: title ?? '',
  });
}

/** Текст чіпа закріпленої версії ядра: Paper — білд, Fabric — лоадер, решта — як є. */
export function coreVersionChipText(kind: ServerKind, coreVersion: string): string {
  if (kind === 'PAPER') return `#${coreVersion}`;
  if (kind === 'FABRIC') return `loader ${coreVersion}`;
  return coreVersion;
}

/** "6153" → "1 год 42 хв"; "750" → "12 хв 30 с". */
export function formatEta(seconds: number): string {
  if (seconds <= 0) return 'майже готово';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h} год ${m} хв`;
  if (m > 0) return `${m} хв ${s} с`;
  return `${s} с`;
}

/**
 * Смужка прогресу прегенерації Chunky. `compact` — стисла версія для картки
 * (тонка, без деталей рядком); повна — над консоллю з відсотком, ETA і швидкістю.
 * Повертає null, коли показувати нічого (немає прогресу або він неактуальний).
 */
export function pregenBar(progress: PregenProgress | null, compact = false): HTMLElement | null {
  if (!progress) return null;
  // Завершене/скасоване на картці не показуємо (щоб не висіло вічно).
  if (compact && progress.state !== 'running') return null;

  const percent = Math.min(100, Math.max(0, progress.percent));
  const finished = progress.state === 'finished';
  const cancelled = progress.state === 'cancelled';
  const barColor = finished ? 'bg-emerald-500' : cancelled ? 'bg-zinc-500' : 'bg-emerald-500';

  const track = el(
    'div',
    { class: `${compact ? 'h-1.5' : 'h-2.5'} w-full overflow-hidden rounded-full bg-zinc-800` },
    el('div', {
      class: `h-full rounded-full ${barColor} transition-all duration-500`,
      style: `width: ${percent}%`,
    }),
  );

  if (compact) {
    return el(
      'div',
      { class: 'space-y-1', title: 'Прегенерація світу Chunky' },
      el(
        'div',
        { class: 'flex items-center justify-between text-[11px] text-zinc-400' },
        el('span', { text: 'Прегенерація світу' }),
        el('span', {
          text:
            `${percent.toFixed(1)}%` +
            (progress.etaSeconds != null ? ` · ${formatEta(progress.etaSeconds)}` : ''),
        }),
      ),
      track,
    );
  }

  const statusText = finished
    ? 'Прегенерацію завершено ✓'
    : cancelled
      ? 'Прегенерацію зупинено'
      : 'Прегенерація світу (Chunky)';
  const details: string[] = [`${progress.processedChunks.toLocaleString('uk')} чанків`];
  if (!finished && !cancelled) {
    if (progress.etaSeconds != null) details.push(`залишилось ~${formatEta(progress.etaSeconds)}`);
    if (progress.rate != null) details.push(`${progress.rate.toFixed(1)} чанків/с`);
  }

  return el(
    'div',
    {
      class:
        'rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 ' +
        (finished ? 'opacity-90' : ''),
    },
    el(
      'div',
      { class: 'mb-1.5 flex items-center justify-between gap-2' },
      el('span', { class: 'text-sm font-medium text-emerald-300', text: statusText }),
      el('span', { class: 'text-sm tabular-nums text-emerald-200', text: `${percent.toFixed(1)}%` }),
    ),
    track,
    el('div', { class: 'mt-1.5 text-xs text-zinc-400', text: details.join(' · ') }),
  );
}

export function formatMemory(memoryMb: number): string {
  if (memoryMb % 1024 === 0) return `${memoryMb / 1024} ГБ`;
  return memoryMb >= 1024 ? `${(memoryMb / 1024).toFixed(1)} ГБ` : `${memoryMb} МБ`;
}

/** Стилі кнопок дій (Tailwind-класи зібрані в одному місці). */
export const BTN = {
  primary:
    'rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  neutral:
    'rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 ' +
    'ring-1 ring-inset ring-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  danger:
    'rounded-lg bg-red-950/60 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-900/70 ' +
    'ring-1 ring-inset ring-red-900/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
} as const;

/**
 * Обгортка дії над сервером: блокує кнопку на час запиту,
 * щоб подвійний клік не породив два start/stop.
 */
export async function withButtonLock(
  button: HTMLButtonElement,
  action: () => Promise<unknown>,
): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}
