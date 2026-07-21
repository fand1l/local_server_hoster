import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { openInputModal } from '../modals';
import { toast } from '../toast';
import { BTN, withButtonLock } from '../ui';
import type { DirListing, FileEntry } from '../types';

/** Людяний розмір файлу. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function iconFor(entry: FileEntry): string {
  if (entry.type === 'directory') return '📁';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['properties', 'yml', 'yaml', 'json', 'toml', 'conf', 'txt', 'log'].includes(ext)) return '📄';
  if (['jar', 'zip', 'gz', 'tar'].includes(ext)) return '📦';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
  return '📄';
}

/**
 * Файловий менеджер сервера: навігація текою, редагування текстових файлів,
 * завантаження/вивантаження, створення тек, перейменування, видалення.
 * Щоб звичайний користувач не мусив лізти в Docker чи термінал.
 * Повертає cleanup (no-op — стан локальний).
 */
export function renderFileManager(root: HTMLElement, serverId: string): () => void {
  let currentPath = '';
  let listing: DirListing | null = null;
  let loadError: string | null = null;
  // Режим: перегляд теки чи редагування файлу.
  let editing: { path: string; content: string } | null = null;

  // ------------------------------------------------------------- навігація

  function joinPath(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
  }
  function parentOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  async function navigate(path: string): Promise<void> {
    editing = null;
    try {
      listing = await api.listFiles(serverId, path);
      currentPath = listing.path;
      loadError = null;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : 'Не вдалося відкрити теку';
    }
    render();
  }

  // ------------------------------------------------------------- дії

  async function openFile(entry: FileEntry): Promise<void> {
    const path = joinPath(currentPath, entry.name);
    try {
      const file = await api.readFile(serverId, path);
      editing = { path: file.path, content: file.content };
      render();
    } catch (err) {
      // Двійковий/завеликий — пропонуємо завантажити.
      if (err instanceof ApiError && err.status === 400) {
        toast(`${err.message}`, 'info');
        download(entry);
      } else {
        toast(err instanceof ApiError ? err.message : 'Не вдалося відкрити файл', 'error');
      }
    }
  }

  function download(entry: FileEntry): void {
    const url = api.downloadFileUrl(serverId, joinPath(currentPath, entry.name));
    const a = el('a', { href: url });
    (a as HTMLAnchorElement).download = entry.name;
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    let ok = 0;
    for (const file of files) {
      try {
        await api.uploadFile(serverId, currentPath, file);
        ok += 1;
      } catch (err) {
        toast(`${file.name}: ${err instanceof ApiError ? err.message : 'помилка'}`, 'error');
      }
    }
    if (ok > 0) toast(`Завантажено файлів: ${ok}`, 'success');
    await navigate(currentPath);
  }

  async function newFolder(): Promise<void> {
    const name = await openInputModal({
      title: 'Нова тека',
      label: 'Назва теки',
      placeholder: 'наприклад, backups',
      submitText: 'Створити',
    });
    if (!name) return;
    try {
      await api.makeDir(serverId, currentPath, name);
      toast('Теку створено', 'success');
      await navigate(currentPath);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не вдалося створити теку', 'error');
    }
  }

  async function rename(entry: FileEntry): Promise<void> {
    const newName = await openInputModal({
      title: 'Перейменувати',
      label: 'Нова назва',
      value: entry.name,
      submitText: 'Перейменувати',
    });
    if (!newName || newName === entry.name) return;
    try {
      await api.renameFile(serverId, joinPath(currentPath, entry.name), newName);
      toast('Перейменовано', 'success');
      await navigate(currentPath);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не вдалося перейменувати', 'error');
    }
  }

  async function remove(entry: FileEntry): Promise<void> {
    const what = entry.type === 'directory' ? 'теку' : 'файл';
    const confirmName = await openInputModal({
      title: `Видалити ${what}?`,
      label: `Введіть «${entry.name}» для підтвердження${entry.type === 'directory' ? ' (тека і весь вміст!)' : ''}`,
      placeholder: entry.name,
      submitText: 'Видалити',
    });
    if (confirmName !== entry.name) {
      if (confirmName !== null) toast('Назву введено неправильно — скасовано', 'info');
      return;
    }
    try {
      await api.deleteFile(serverId, joinPath(currentPath, entry.name));
      toast(`Видалено ${entry.name}`, 'success');
      await navigate(currentPath);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не вдалося видалити', 'error');
    }
  }

  // ------------------------------------------------------------- рендер

  function breadcrumbs(): HTMLElement {
    const parts = currentPath ? currentPath.split('/') : [];
    const crumbs: HTMLElement[] = [
      el('button', {
        class: 'text-emerald-400 hover:text-emerald-300',
        text: 'корінь',
        onClick: () => void navigate(''),
      }),
    ];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      crumbs.push(el('span', { class: 'text-zinc-600', text: '/' }));
      crumbs.push(
        el('button', {
          class: 'text-zinc-300 hover:text-emerald-400',
          text: part,
          onClick: () => void navigate(target),
        }),
      );
    }
    return el('div', { class: 'flex flex-wrap items-center gap-1 text-sm' }, ...crumbs);
  }

  /** Відкрити елемент: тека → навігація, файл → редактор. */
  function activate(entry: FileEntry): void {
    if (entry.type === 'directory') void navigate(joinPath(currentPath, entry.name));
    else void openFile(entry);
  }

  /** Обгортка обробника кнопки-дії: гасимо спливання, щоб не спрацював клік боксу. */
  function rowAction(fn: () => void): (e: Event) => void {
    return (e: Event) => {
      e.stopPropagation();
      fn();
    };
  }

  function fileRow(entry: FileEntry): HTMLElement {
    const smallBtn =
      'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset transition duration-100 active:scale-[0.97]';

    const nameEl = el('span', {
      class: 'block truncate text-sm font-medium text-zinc-100 transition-colors group-hover:text-emerald-400',
      text: entry.name,
    });

    const actions: HTMLElement[] = [];
    if (entry.type === 'file') {
      actions.push(
        el('button', {
          class: `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`,
          text: '⤓',
          title: 'Завантажити',
          onClick: rowAction(() => download(entry)),
        }),
      );
    }
    actions.push(
      el('button', {
        class: `${smallBtn} bg-zinc-800 text-zinc-200 ring-zinc-700 hover:bg-zinc-700`,
        text: 'Перейм.',
        onClick: rowAction(() => void rename(entry)),
      }),
      el('button', {
        class: `${smallBtn} bg-red-950/60 text-red-300 ring-red-900/60 hover:bg-red-900/50`,
        text: 'Видалити',
        onClick: rowAction(() => void remove(entry)),
      }),
    );

    // Весь бокс — одна велика кнопка (клік/Enter/Space). Кнопки дій усередині
    // гасять спливання, тож не запускають навігацію.
    const box = el(
      'div',
      {
        class:
          'group lift flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 ' +
          'bg-zinc-900/40 px-3 py-2 hover:border-zinc-700 hover:bg-zinc-800/50 ' +
          'hover:shadow-lg hover:shadow-black/20',
        title: entry.type === 'directory' ? 'Відкрити теку' : 'Відкрити для редагування',
        onClick: () => activate(entry),
        onKeydown: (e) => {
          // Enter/Space лише коли сфокусований сам бокс, а не кнопка-дія в ньому.
          if (e.target !== e.currentTarget) return;
          const key = (e as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            activate(entry);
          }
        },
      },
      el('span', { class: 'shrink-0 text-lg', text: iconFor(entry) }),
      el(
        'div',
        { class: 'min-w-0 flex-1' },
        nameEl,
        el('div', {
          class: 'text-xs text-zinc-500',
          text: entry.type === 'directory' ? 'тека' : formatSize(entry.sizeBytes),
        }),
      ),
      el('div', { class: 'flex shrink-0 items-center gap-1' }, ...actions),
    );
    box.setAttribute('role', 'button');
    box.tabIndex = 0;
    return box;
  }

  function renderList(): void {
    const fileInput = el('input', { type: 'file', class: 'hidden' }) as HTMLInputElement;
    fileInput.multiple = true;
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) void uploadFiles(fileInput.files);
      fileInput.value = '';
    });

    const toolbar = el(
      'div',
      { class: 'flex flex-wrap items-center justify-between gap-2' },
      breadcrumbs(),
      el(
        'div',
        { class: 'flex gap-2' },
        el('button', { class: BTN.neutral, text: '⤒ Завантажити', onClick: () => fileInput.click() }),
        el('button', { class: BTN.neutral, text: '+ Тека', onClick: () => void newFolder() }),
        el('button', { class: BTN.neutral, text: '⟳', title: 'Оновити', onClick: () => void navigate(currentPath) }),
      ),
    );

    const children: (HTMLElement | null)[] = [toolbar, fileInput];

    // Drag&drop завантаження прямо в область списку.
    const listArea = el('div', { class: 'space-y-2 rounded-lg' });
    const rows: HTMLElement[] = [];
    if (currentPath) {
      const goUp = () => void navigate(parentOf(currentPath));
      const upBox = el(
        'div',
        {
          class:
            'group lift flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800/60 ' +
            'bg-zinc-900/30 px-3 py-2 hover:border-zinc-700 hover:bg-zinc-800/40',
          title: 'На рівень вище',
          onClick: goUp,
          onKeydown: (e) => {
            if (e.target !== e.currentTarget) return;
            const key = (e as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') {
              e.preventDefault();
              goUp();
            }
          },
        },
        el('span', { class: 'shrink-0 text-lg', text: '↩' }),
        el('span', {
          class: 'text-sm font-medium text-zinc-300 transition-colors group-hover:text-emerald-400',
          text: '.. (на рівень вище)',
        }),
      );
      upBox.setAttribute('role', 'button');
      upBox.tabIndex = 0;
      rows.push(upBox);
    }
    if (listing && listing.entries.length > 0) {
      rows.push(...listing.entries.map(fileRow));
    } else if (listing && !currentPath) {
      rows.push(
        el('p', {
          class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-8 text-center text-sm text-zinc-500',
          text: 'Тека порожня. Файли зʼявляться після першого запуску сервера, або завантажте свої.',
        }),
      );
    } else if (listing) {
      rows.push(
        el('p', {
          class: 'rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500',
          text: 'Тека порожня.',
        }),
      );
    }
    mount(listArea, ...rows);

    listArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      listArea.classList.add('ring-1', 'ring-emerald-600/60');
    });
    listArea.addEventListener('dragleave', () => listArea.classList.remove('ring-1', 'ring-emerald-600/60'));
    listArea.addEventListener('drop', (event) => {
      event.preventDefault();
      listArea.classList.remove('ring-1', 'ring-emerald-600/60');
      const dt = (event as DragEvent).dataTransfer;
      if (dt?.files && dt.files.length > 0) void uploadFiles(dt.files);
    });
    children.push(listArea);

    if (loadError) children.unshift(el('p', { class: 'text-sm text-red-400', text: loadError }));

    mount(root, el('div', { class: 'space-y-3' }, ...children.filter(Boolean) as HTMLElement[]));
  }

  function renderEditor(): void {
    if (!editing) return;
    const filename = editing.path.split('/').pop() ?? editing.path;

    const textarea = el('textarea', {
      class:
        'console-output thin-scroll h-[26rem] w-full resize-y rounded-lg border border-zinc-800 ' +
        'bg-black/70 p-3 text-zinc-200 focus:border-emerald-500 focus:outline-none',
      spellcheck: 'false',
    }) as HTMLTextAreaElement;
    textarea.value = editing.content;

    const saveButton = el('button', { class: BTN.primary, text: 'Зберегти' });
    saveButton.addEventListener('click', () =>
      withButtonLock(saveButton, async () => {
        try {
          await api.writeFile(serverId, editing!.path, textarea.value);
          toast('Файл збережено', 'success');
          editing = { path: editing!.path, content: textarea.value };
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Не вдалося зберегти', 'error');
        }
      }),
    );

    mount(
      root,
      el(
        'div',
        { class: 'space-y-3' },
        el(
          'div',
          { class: 'flex items-center justify-between gap-2' },
          el(
            'button',
            {
              class: 'text-sm text-zinc-400 hover:text-zinc-200',
              text: '← до файлів',
              onClick: () => void navigate(currentPath),
            },
          ),
          el('span', { class: 'truncate font-mono text-sm text-zinc-300', text: editing.path }),
        ),
        el('p', { class: 'text-xs text-zinc-500', text: `Редагування ${filename}. Зміни на диску застосуються серверу після перезапуску.` }),
        textarea,
        el('div', { class: 'flex gap-2' }, saveButton),
      ),
    );
  }

  function render(): void {
    if (editing) renderEditor();
    else renderList();
  }

  void navigate('');
  return () => {};
}
