import { api, ApiError } from './api';
import { el } from './dom';
import { toast } from './toast';
import { BTN, KIND_LABELS } from './ui';
import { SERVER_KINDS, type ServerKind, type ServerView } from './types';

/** Загальний каркас модального вікна. Повертає функцію закриття. */
function openModal(title: string, body: HTMLElement): () => void {
  const close = (): void => overlay.remove();

  const overlay = el(
    'div',
    {
      class: 'fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4',
      onClick: (event) => {
        if (event.target === overlay) close(); // клік по фону закриває
      },
    },
    el(
      'div',
      {
        class:
          'w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl ' +
          'max-h-[90vh] overflow-y-auto thin-scroll',
      },
      el(
        'div',
        { class: 'mb-4 flex items-center justify-between' },
        el('h2', { class: 'text-lg font-semibold text-zinc-100', text: title }),
        el('button', {
          class: 'text-zinc-500 hover:text-zinc-200 text-xl leading-none px-1',
          text: '✕',
          title: 'Закрити',
          onClick: close,
        }),
      ),
      body,
    ),
  );

  document.body.append(overlay);
  return close;
}

/** Поле форми з підписом. */
function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return el(
    'label',
    { class: 'block' },
    el('span', { class: 'mb-1 block text-sm text-zinc-400', text: labelText }),
    input,
    hint ? el('span', { class: 'mt-1 block text-xs text-zinc-500', text: hint }) : null,
  );
}

const INPUT_CLASS =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ' +
  'placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none';

const VERSION_SUGGESTIONS = [
  'LATEST',
  '1.21.8',
  '1.21.4',
  '1.20.6',
  '1.20.4',
  '1.19.4',
  '1.18.2',
  '1.16.5',
  '1.12.2',
];

const MEMORY_OPTIONS_MB = [1024, 2048, 3072, 4096, 6144, 8192];

/** Модалка створення сервера. onCreated викликається після успішного POST. */
export function openCreateServerModal(suggestedPort: number, onCreated: () => void): void {
  const nameInput = el('input', {
    class: INPUT_CLASS,
    type: 'text',
    placeholder: 'Мій сервер виживання',
    required: true,
  });

  const kindSelect = el(
    'select',
    { class: INPUT_CLASS },
    ...SERVER_KINDS.map((kind) =>
      el('option', {
        value: kind,
        text: kind === 'PAPER' ? `${KIND_LABELS[kind]} (рекомендовано)` : KIND_LABELS[kind],
        selected: kind === 'PAPER',
      }),
    ),
  );

  const versionInput = el('input', {
    class: INPUT_CLASS,
    type: 'text',
    value: '1.21.8',
    list: 'mc-versions',
    required: true,
  });
  const versionDatalist = el(
    'datalist',
    { id: 'mc-versions' },
    ...VERSION_SUGGESTIONS.map((version) => el('option', { value: version })),
  );

  const portInput = el('input', {
    class: INPUT_CLASS,
    type: 'number',
    min: '1024',
    max: '65535',
    value: String(suggestedPort),
    required: true,
  });

  const memorySelect = el(
    'select',
    { class: INPUT_CLASS },
    ...MEMORY_OPTIONS_MB.map((mb) =>
      el('option', { value: String(mb), text: `${mb / 1024} ГБ`, selected: mb === 2048 }),
    ),
  );

  const autoStartCheckbox = el('input', { type: 'checkbox', checked: true, class: 'accent-emerald-500' });
  const eulaCheckbox = el('input', { type: 'checkbox', class: 'accent-emerald-500', required: true });

  const errorBox = el('p', { class: 'hidden text-sm text-red-400' });
  const submitButton = el('button', { class: `${BTN.primary} w-full py-2`, type: 'submit', text: 'Створити сервер' });

  const form = el(
    'form',
    {
      class: 'space-y-4',
      onSubmit: (event) => {
        event.preventDefault();
        void submit();
      },
    },
    field('Назва', nameInput),
    el(
      'div',
      { class: 'grid grid-cols-2 gap-3' },
      field('Тип ядра', kindSelect),
      field('Версія', versionInput, 'Наприклад: 1.21.8 або LATEST'),
    ),
    versionDatalist,
    el(
      'div',
      { class: 'grid grid-cols-2 gap-3' },
      field('Порт на цьому комп’ютері', portInput, 'Гравці підключаються до нього'),
      field('Пам’ять (JVM)', memorySelect),
    ),
    el(
      'label',
      { class: 'flex items-center gap-2 text-sm text-zinc-300' },
      autoStartCheckbox,
      'Запустити одразу після створення',
    ),
    el(
      'label',
      { class: 'flex items-start gap-2 text-sm text-zinc-300' },
      eulaCheckbox,
      el(
        'span',
        {},
        'Я приймаю ',
        el('a', {
          class: 'text-emerald-400 underline hover:text-emerald-300',
          href: 'https://aka.ms/MinecraftEULA',
          target: '_blank',
          rel: 'noreferrer',
          text: 'Minecraft EULA',
        }),
      ),
    ),
    errorBox,
    submitButton,
  );

  const close = openModal('Новий Minecraft-сервер', form);

  async function submit(): Promise<void> {
    errorBox.classList.add('hidden');
    submitButton.disabled = true;
    try {
      await api.createServer({
        name: nameInput.value.trim(),
        kind: kindSelect.value as ServerKind,
        version: versionInput.value.trim(),
        hostPort: Number(portInput.value),
        memoryMb: Number(memorySelect.value),
        acceptEula: eulaCheckbox.checked as true,
        autoStart: autoStartCheckbox.checked,
      });
      close();
      toast('Сервер створюється: образ завантажується у фоні', 'success');
      onCreated();
    } catch (err) {
      errorBox.textContent = err instanceof ApiError ? err.message : 'Не вдалося створити сервер';
      errorBox.classList.remove('hidden');
    } finally {
      submitButton.disabled = false;
    }
  }
}

/** Модалка підтвердження видалення (з опцією видалення файлів світу). */
export function openDeleteServerModal(server: ServerView, onDeleted: () => void): void {
  const deleteDataCheckbox = el('input', { type: 'checkbox', class: 'accent-red-500' });
  const errorBox = el('p', { class: 'hidden text-sm text-red-400' });
  const confirmButton = el('button', { class: `${BTN.danger} w-full py-2`, text: 'Видалити назавжди' });

  confirmButton.addEventListener('click', () => void confirm());

  const body = el(
    'div',
    { class: 'space-y-4' },
    el('p', { class: 'text-sm text-zinc-300' }, `Видалити сервер «${server.name}»? Контейнер буде зупинено та знищено.`),
    el(
      'label',
      { class: 'flex items-center gap-2 text-sm text-zinc-300' },
      deleteDataCheckbox,
      'Також видалити файли сервера (світ, налаштування) — незворотно',
    ),
    errorBox,
    confirmButton,
  );

  const close = openModal('Видалення сервера', body);

  async function confirm(): Promise<void> {
    errorBox.classList.add('hidden');
    confirmButton.disabled = true;
    try {
      await api.deleteServer(server.id, deleteDataCheckbox.checked);
      close();
      toast(`Сервер «${server.name}» видалено`, 'success');
      onDeleted();
    } catch (err) {
      errorBox.textContent = err instanceof ApiError ? err.message : 'Не вдалося видалити сервер';
      errorBox.classList.remove('hidden');
      confirmButton.disabled = false;
    }
  }
}
