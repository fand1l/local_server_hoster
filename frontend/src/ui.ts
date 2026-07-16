import { el } from './dom';
import type { RuntimeStatus, ServerKind, ServerView } from './types';

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
};

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
