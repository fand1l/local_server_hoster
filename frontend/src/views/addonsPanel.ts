import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { toast } from '../toast';
import { BTN, withButtonLock } from '../ui';
import type { AddonInfo, AddonSearchHit, AddonSearchResponse, AddonsResponse } from '../types';

/** Людяний розмір файлу. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Скорочене число завантажень: 1.5M, 12K, 240. */
function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const INPUT_CLASS =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ' +
  'placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none';

/**
 * Вкладка плагінів/модів = магазин контенту:
 *  - пошук і встановлення з Modrinth (сумісного з ядром+версією сервера);
 *  - список встановлених із видаленням;
 *  - запасний варіант — завантажити власний .jar (drag-and-drop).
 * Викликається лише для ядер, що підтримують доповнення (не Vanilla).
 * Повертає cleanup (наразі no-op).
 */
export function renderAddonsPanel(root: HTMLElement, serverId: string): () => void {
  let data: AddonsResponse | null = null;
  let loadError: string | null = null;
  let uploading = false;

  // Стан пошуку Modrinth.
  let searchQuery = '';
  let searchResults: AddonSearchResponse | null = null;
  let searching = false;
  const installingIds = new Set<string>();
  const installedIds = new Set<string>();

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

  // ------------------------------------------------------------- Modrinth

  async function runSearch(): Promise<void> {
    searching = true;
    render();
    try {
      searchResults = await api.searchAddons(serverId, searchQuery.trim());
    } catch (err) {
      searchResults = null;
      toast(err instanceof ApiError ? err.message : 'Пошук не вдався', 'error');
    }
    searching = false;
    render();
  }

  async function install(hit: AddonSearchHit): Promise<void> {
    if (installingIds.has(hit.projectId)) return;
    installingIds.add(hit.projectId);
    render();
    try {
      await api.installAddon(serverId, hit.projectId);
      installedIds.add(hit.projectId);
      toast(`Встановлено «${hit.title}»`, 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не вдалося встановити', 'error');
    } finally {
      installingIds.delete(hit.projectId);
      render();
    }
  }

  function searchBar(): HTMLElement {
    const input = el('input', {
      class: INPUT_CLASS,
      type: 'text',
      value: searchQuery,
      placeholder: `Пошук ${nounPlural()} на Modrinth…`,
      spellcheck: 'false',
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      searchQuery = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        void runSearch();
      }
    });
    const button = el('button', {
      class: `${BTN.primary} shrink-0`,
      text: 'Знайти',
      onClick: () => void runSearch(),
    });
    return el('div', { class: 'flex gap-2' }, input, button);
  }

  function hitCard(hit: AddonSearchHit): HTMLElement {
    const installing = installingIds.has(hit.projectId);
    const installed = installedIds.has(hit.projectId);

    const installButton = el('button', {
      class: `${BTN.primary} shrink-0 self-center text-xs`,
      text: installed ? 'Встановлено ✓' : installing ? 'Встановлення…' : 'Встановити',
      disabled: installing || installed,
      onClick: () => void install(hit),
    });

    // Іконка проєкту (падіння картинки лишає сірий плейсхолдер).
    const icon = hit.iconUrl
      ? (el('img', {
          class: 'size-10 shrink-0 rounded-md bg-zinc-800 object-cover',
          src: hit.iconUrl,
          alt: '',
          loading: 'lazy',
        }) as HTMLImageElement)
      : el('div', {
          class: 'flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-lg',
          text: '🧩',
        });

    return el(
      'div',
      { class: 'flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2' },
      icon,
      el(
        'div',
        { class: 'min-w-0 flex-1' },
        el(
          'div',
          { class: 'flex items-center gap-2' },
          el('span', { class: 'truncate text-sm font-medium text-zinc-100', text: hit.title }),
          hit.author
            ? el('span', { class: 'shrink-0 text-xs text-zinc-500', text: `від ${hit.author}` })
            : null,
        ),
        hit.description
          ? el('div', { class: 'mt-0.5 line-clamp-2 text-xs text-zinc-400', text: hit.description })
          : null,
        el('div', { class: 'mt-0.5 text-xs text-zinc-500', text: `⬇ ${formatDownloads(hit.downloads)}` }),
      ),
      installButton,
    );
  }

  function searchSection(): HTMLElement {
    const children: (HTMLElement | null)[] = [
      el('h3', { class: 'text-sm font-medium text-zinc-300', text: `Знайти ${nounPlural()} на Modrinth` }),
      searchBar(),
    ];

    if (searching) {
      children.push(
        el('p', { class: 'px-1 py-4 text-center text-sm text-zinc-500', text: 'Пошук на Modrinth…' }),
      );
    } else if (searchResults) {
      if (searchResults.source === 'offline') {
        children.push(
          el('p', {
            class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-sm text-zinc-500',
            text: 'Немає з’єднання з Modrinth. Можна завантажити свій .jar нижче.',
          }),
        );
      } else if (searchResults.hits.length === 0) {
        children.push(
          el('p', {
            class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-sm text-zinc-500',
            text: `Нічого сумісного не знайдено для цієї версії гри. Спробуйте інший запит.`,
          }),
        );
      } else {
        children.push(el('div', { class: 'space-y-2' }, ...searchResults.hits.map(hitCard)));
      }
    }

    return el('div', { class: 'space-y-2' }, ...children.filter(Boolean) as HTMLElement[]);
  }

  // ------------------------------------------------------- завантаження .jar

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
          'flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed ' +
          'border-zinc-700 bg-zinc-900/40 px-4 py-6 text-center transition-colors ' +
          (uploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer hover:border-emerald-600/70'),
      },
      el('div', { class: 'text-2xl', text: uploading ? '⏳' : '📦' }),
      el('p', {
        class: 'text-sm text-zinc-300',
        text: uploading ? 'Завантаження…' : `Перетягніть свій .jar сюди, щоб встановити ${noun()}`,
      }),
      el('p', { class: 'text-xs text-zinc-500', text: 'або натисніть, щоб обрати файл' }),
    );

    zone.addEventListener('click', () => fileInput.click());

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

  function installedSection(): HTMLElement | null {
    if (!data) return null;
    const count = data.addons.length;
    const children: HTMLElement[] = [
      el('h3', {
        class: 'text-sm font-medium text-zinc-300',
        text: `Встановлені ${nounPlural()} (${count})`,
      }),
    ];
    if (count === 0) {
      children.push(
        el('p', {
          class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500',
          text: 'Ще нічого не встановлено. Знайдіть щось на Modrinth вище або завантажте свій .jar.',
        }),
      );
    } else {
      children.push(el('div', { class: 'space-y-2' }, ...data.addons.map(addonRow)));
    }
    return el('div', { class: 'space-y-2' }, ...children);
  }

  function render(): void {
    const children: (HTMLElement | null)[] = [];

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

    children.push(searchSection());
    children.push(installedSection());
    // Запасний варіант — власний файл (вторинний, унизу).
    children.push(
      el(
        'div',
        { class: 'space-y-2' },
        el('h3', { class: 'text-sm font-medium text-zinc-300', text: 'Або завантажте свій .jar' }),
        dropZone(),
      ),
    );

    mount(root, el('div', { class: 'space-y-5' }, ...children.filter(Boolean) as HTMLElement[]));
  }

  render();
  void refresh();
  // Одразу підвантажуємо популярне (порожній запит) — щоб секція не була порожня.
  void runSearch();
  return () => {};
}
