import { el } from './dom';

type ToastKind = 'success' | 'error' | 'info';

const TOAST_LIFETIME_MS = 4200;

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = el('div', {
      class: 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none',
    });
    document.body.append(container);
  }
  return container;
}

const KIND_CLASSES: Record<ToastKind, string> = {
  success: 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
  error: 'border-red-500/40 bg-red-950/90 text-red-100',
  info: 'border-zinc-600/60 bg-zinc-900/95 text-zinc-100',
};

/** Показує спливаюче повідомлення у правому нижньому куті. */
export function toast(message: string, kind: ToastKind = 'info'): void {
  const node = el('div', {
    class:
      `pointer-events-auto max-w-sm rounded-lg border px-4 py-2.5 text-sm shadow-xl ` +
      `transition-opacity duration-300 ${KIND_CLASSES[kind]}`,
    text: message,
  });
  ensureContainer().append(node);

  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 350);
  }, TOAST_LIFETIME_MS);
}
