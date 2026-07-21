import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { toast } from '../toast';
import { BTN, withButtonLock } from '../ui';
import type { AddonInfo, AddonsResponse } from '../types';

/** Людяний розмір файлу. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Вкладка плагінів/модів: drag-and-drop .jar, список встановлених із видаленням.
 * Викликається лише для ядер, що підтримують доповнення (не Vanilla).
 * Повертає cleanup (наразі no-op, для однаковості з іншими вкладками).
 */
export function renderAddonsPanel(root: HTMLElement, serverId: string): () => void {
  let data: AddonsResponse | null = null;
  let loadError: string | null = null;
  let uploading = false;

  const noun = () => (data?.category === 'mods' ? 'мод' : 'плагін');
  const nounPlural = () => (data?.category === 'mods' ? 'моди' : 'плагіни');

  async function refresh(): Promise<void> {
    try {
      data = await api.listAddons(serverId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : 'Не вдалося завантажити список';
    }
    render();
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const jars = [...files].filter((f) => f.name.toLowerCase().endsWith('.jar'));
    const nonJars = [...files].length - jars.length;
    if (nonJars > 0) {
      toast(`Пропущено ${nonJars} не-.jar файл(ів) — приймаються лише .jar`, 'error');
    }
    if (jars.length === 0) return;

    uploading = true;
    render();
    let ok = 0;
    for (const file of jars) {
      try {
        await api.uploadAddon(serverId, file);
        ok += 1;
      } catch (err) {
        toast(
          `${file.name}: ${err instanceof ApiError ? err.message : 'помилка завантаження'}`,
          'error',
        );
      }
    }
    uploading = false;
    if (ok > 0) toast(`Встановлено файлів: ${ok}`, 'success');
    await refresh();
  }

  async function removeAddon(button: HTMLButtonElement, addon: AddonInfo): Promise<void> {
    await withButtonLock(button, async () => {
      try {
        await api.deleteAddon(serverId, addon.filename);
        toast(`Видалено ${addon.filename}`, 'success');
        await refresh();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Не вдалося видалити', 'error');
      }
    });
  }

  function dropZone(): HTMLElement {
    const fileInput = el('input', { type: 'file', class: 'hidden' }) as HTMLInputElement;
    fileInput.accept = '.jar';
    fileInput.multiple = true;
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) void uploadFiles(fileInput.files);
      fileInput.value = '';
    });

    const zone = el(
      'div',
      {
        class:
          'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed ' +
          'border-zinc-700 bg-zinc-900/40 px-4 py-10 text-center transition-colors ' +
          (uploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer hover:border-emerald-600/70'),
      },
      el('div', { class: 'text-3xl', text: uploading ? '⏳' : '📦' }),
      el('p', {
        class: 'text-sm text-zinc-300',
        text: uploading
          ? 'Завантаження…'
          : `Перетягніть .jar-файл сюди, щоб встановити ${noun()}`,
      }),
      el('p', { class: 'text-xs text-zinc-500', text: 'або натисніть, щоб обрати файл' }),
    );

    zone.addEventListener('click', () => fileInput.click());

    // Підсвічування при перетягуванні над зоною.
    const activate = (on: boolean) => (e: Event) => {
      e.preventDefault();
      zone.classList.toggle('border-emerald-500', on);
      zone.classList.toggle('bg-emerald-950/20', on);
    };
    zone.addEventListener('dragover', activate(true));
    zone.addEventListener('dragenter', activate(true));
    zone.addEventListener('dragleave', activate(false));
    zone.addEventListener('drop', (event) => {
      activate(false)(event);
      const dt = (event as DragEvent).dataTransfer;
      if (dt?.files && dt.files.length > 0) void uploadFiles(dt.files);
    });

    return el('div', {}, zone, fileInput);
  }

  function addonRow(addon: AddonInfo): HTMLElement {
    const deleteButton = el('button', {
      class: `${BTN.danger} text-xs`,
      text: 'Видалити',
    });
    deleteButton.addEventListener('click', () =>
      void removeAddon(deleteButton as HTMLButtonElement, addon),
    );

    return el(
      'div',
      { class: 'flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2' },
      el('span', { class: 'text-lg', text: '🧩' }),
      el(
        'div',
        { class: 'min-w-0 flex-1' },
        el('div', { class: 'truncate text-sm font-medium text-zinc-100', text: addon.filename }),
        el('div', { class: 'text-xs text-zinc-500', text: formatSize(addon.sizeBytes) }),
      ),
      deleteButton,
    );
  }

  function render(): void {
    const children: (HTMLElement | null)[] = [];

    // Попередження про рестарт — угорі, як на інших вкладках (єдиний стиль).
    if (data?.requiresRestart) {
      children.push(
        el('p', {
          class: 'rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300',
          text: `Сервер запущено: встановлені або видалені ${nounPlural()} застосуються після перезапуску.`,
        }),
      );
    }
    if (loadError) {
      children.push(el('p', { class: 'text-sm text-red-400', text: loadError }));
    }

    children.push(dropZone());

    if (data) {
      const count = data.addons.length;
      children.push(
        el(
          'div',
          { class: 'flex items-center justify-between' },
          el('h3', {
            class: 'text-sm font-medium text-zinc-300',
            text: `Встановлені ${nounPlural()} (${count})`,
          }),
        ),
      );
      if (count === 0) {
        children.push(
          el('p', {
            class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500',
            text: `Ще нічого не встановлено. Перетягніть .jar вище.`,
          }),
        );
      } else {
        children.push(el('div', { class: 'space-y-2' }, ...data.addons.map(addonRow)));
      }
    }

    mount(root, el('div', { class: 'space-y-3' }, ...children));
  }

  render();
  void refresh();
  return () => {};
}
