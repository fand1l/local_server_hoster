import { api, ApiError } from './api';
import { el, mount } from './dom';
import { toast } from './toast';
import { BTN } from './ui';
import type { ServerKind, ServerView, SystemInfo } from './types';

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

const VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Ядра, доступні у майстрі (інші типи додамо пізніше). */
const WIZARD_KINDS: Array<{ kind: ServerKind; title: string; description: string }> = [
  {
    kind: 'PAPER',
    title: 'Paper',
    description: 'Рекомендовано: оптимізований сервер із підтримкою плагінів',
  },
  {
    kind: 'FABRIC',
    title: 'Fabric',
    description: 'Для модів на Fabric Loader',
  },
];

/** Стан майстра — живе між кроками. */
interface WizardState {
  name: string;
  kind: ServerKind;
  version: string;
  /** '' = «остання» (не закріплювати). */
  coreVersion: string;
  hostPort: number;
  memoryMb: number;
  cpuCores: number;
  autoStart: boolean;
  acceptEula: boolean;
}

/**
 * Майстер створення сервера у 3 кроки:
 *   1) назва + ядро → 2) версія гри ↔ версія ядра → 3) ресурси (ОЗП/ЦП) + порт.
 * Списки версій приходять із бекенда (/api/meta/*), тому сумісність
 * «гра ↔ ядро» гарантована: версії ядра запитуються під обрану версію гри.
 */
export function openCreateServerModal(suggestedPort: number, onCreated: () => void): void {
  const state: WizardState = {
    name: '',
    kind: 'PAPER',
    version: '',
    coreVersion: '',
    hostPort: suggestedPort,
    memoryMb: 2048,
    cpuCores: 2,
    autoStart: true,
    acceptEula: false,
  };

  let step: 1 | 2 | 3 = 1;
  let system: SystemInfo | null = null;

  const body = el('div', {});
  const close = openModal('Новий Minecraft-сервер', body);

  // Межі повзунків ресурсів — із реальних характеристик машини.
  void api
    .system()
    .then((info) => {
      system = info;
      if (step === 3) render(); // якщо користувач уже на кроці ресурсів — оновити межі
    })
    .catch(() => {
      /* без /api/system повзунки отримають безпечні дефолти */
    });

  // ---------------------------------------------------------------- каркас

  function stepIndicator(): HTMLElement {
    const labels = ['Назва та ядро', 'Версії', 'Ресурси'];
    return el(
      'div',
      { class: 'mb-5 flex items-center gap-2' },
      ...labels.flatMap((label, index) => {
        const number = (index + 1) as 1 | 2 | 3;
        const active = number === step;
        const done = number < step;
        const dot = el('span', {
          class:
            'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
            (active
              ? 'bg-emerald-600 text-white'
              : done
                ? 'bg-emerald-950 text-emerald-400 ring-1 ring-emerald-800'
                : 'bg-zinc-800 text-zinc-500'),
          text: done ? '✓' : String(number),
        });
        const caption = el('span', {
          class: 'text-xs ' + (active ? 'text-zinc-200' : 'text-zinc-500'),
          text: label,
        });
        const parts: HTMLElement[] = [
          el('span', { class: 'flex items-center gap-1.5' }, dot, caption),
        ];
        if (index < labels.length - 1) {
          parts.push(el('span', { class: 'h-px flex-1 bg-zinc-800' }));
        }
        return parts;
      }),
    );
  }

  function navButtons(next: HTMLElement): HTMLElement {
    const back = el('button', {
      class: `${BTN.neutral} px-5`,
      text: '← Назад',
      onClick: () => {
        step = (step - 1) as 1 | 2 | 3;
        render();
      },
    });
    return el(
      'div',
      { class: 'mt-5 flex items-center justify-between gap-2' },
      step > 1 ? back : el('span', {}),
      next,
    );
  }

  const errorBox = el('p', { class: 'hidden text-sm text-red-400' });
  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }
  function clearError(): void {
    errorBox.classList.add('hidden');
  }

  function render(): void {
    clearError();
    const content = step === 1 ? renderStep1() : step === 2 ? renderStep2() : renderStep3();
    mount(body, stepIndicator(), content, errorBox);
  }

  // -------------------------------------------------- крок 1: назва + ядро

  function renderStep1(): HTMLElement {
    const nameInput = el('input', {
      class: INPUT_CLASS,
      type: 'text',
      placeholder: 'Мій сервер виживання',
      value: state.name,
      onInput: (event) => {
        state.name = (event.target as HTMLInputElement).value;
      },
    });

    const kindCards = WIZARD_KINDS.map(({ kind, title, description }) => {
      const selected = state.kind === kind;
      return el(
        'button',
        {
          type: 'button',
          class:
            'flex-1 rounded-xl border p-3 text-left transition-colors ' +
            (selected
              ? 'border-emerald-500 bg-emerald-950/40'
              : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500'),
          onClick: () => {
            if (state.kind !== kind) {
              state.kind = kind;
              // Ядро змінилося — раніше обрані версії більше не мають сенсу.
              state.version = '';
              state.coreVersion = '';
            }
            render();
          },
        },
        el('span', {
          class: 'block text-sm font-semibold ' + (selected ? 'text-emerald-300' : 'text-zinc-200'),
          text: title,
        }),
        el('span', { class: 'mt-0.5 block text-xs text-zinc-500', text: description }),
      );
    });

    const nextButton = el('button', {
      class: `${BTN.primary} px-6`,
      text: 'Далі →',
      onClick: () => {
        if (!nameInput.value.trim()) {
          showError('Вкажіть назву сервера');
          nameInput.focus();
          return;
        }
        state.name = nameInput.value.trim();
        step = 2;
        render();
      },
    });

    return el(
      'div',
      { class: 'space-y-4' },
      field('Назва сервера', nameInput),
      el(
        'div',
        {},
        el('span', { class: 'mb-1 block text-sm text-zinc-400', text: 'Ядро сервера' }),
        el('div', { class: 'flex gap-2' }, ...kindCards),
      ),
      navButtons(nextButton),
    );
  }

  // ------------------------------------ крок 2: версія гри ↔ версія ядра

  function renderStep2(): HTMLElement {
    const versionInput = el('input', {
      class: INPUT_CLASS,
      type: 'text',
      placeholder: 'Завантаження списку…',
      value: state.version,
      list: 'wizard-game-versions',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    const versionDatalist = el('datalist', { id: 'wizard-game-versions' });
    const versionHint = el('p', { class: 'mt-1 text-xs text-zinc-500', text: '' });

    const coreLabel = state.kind === 'PAPER' ? 'Білд Paper' : 'Версія Fabric Loader';
    const coreSelect = el('select', { class: INPUT_CLASS });
    const coreHint = el('p', { class: 'mt-1 text-xs text-zinc-500', text: '' });

    function fillCoreSelect(versions: string[], latest: string | null, note: string): void {
      const options: HTMLElement[] = [
        el('option', {
          value: '',
          text: latest
            ? `Остання (${state.kind === 'PAPER' ? '#' : ''}${latest}) — рекомендовано`
            : 'Остання — рекомендовано',
          selected: state.coreVersion === '',
        }),
        ...versions.map((coreVersion) =>
          el('option', {
            value: coreVersion,
            text: state.kind === 'PAPER' ? `Білд #${coreVersion}` : coreVersion,
            selected: state.coreVersion === coreVersion,
          }),
        ),
      ];
      mount(coreSelect, ...options);
      coreHint.textContent = note;
    }

    /** Тягне версії ядра під конкретну версію гри — саме тут «перевірка сумісності». */
    let coreRequestToken = 0;
    async function loadCoreVersions(): Promise<void> {
      const gameVersion = versionInput.value.trim();
      if (!VERSION_PATTERN.test(gameVersion)) {
        fillCoreSelect([], null, '');
        return;
      }
      const token = ++coreRequestToken;
      coreHint.textContent = 'Перевірка сумісних версій…';
      try {
        const result = await api.metaCoreVersions(state.kind, gameVersion);
        if (token !== coreRequestToken) return; // користувач уже змінив версію
        if (result.source === 'fallback') {
          fillCoreSelect([], null, 'Немає з’єднання з каталогом — буде використана остання версія.');
        } else if (result.versions.length === 0) {
          fillCoreSelect([], null, `Для ${gameVersion} ще немає збірок ${state.kind === 'PAPER' ? 'Paper' : 'Fabric'} — оберіть іншу версію гри.`);
        } else {
          fillCoreSelect(
            result.versions.slice(0, 50),
            result.latest,
            `Сумісних версій: ${result.versions.length}`,
          );
        }
      } catch {
        if (token !== coreRequestToken) return;
        fillCoreSelect([], null, 'Не вдалося перевірити версії ядра — буде використана остання.');
      }
    }

    coreSelect.addEventListener('change', () => {
      state.coreVersion = (coreSelect as HTMLSelectElement).value;
    });

    // Зміна версії гри → перезапит сумісних версій ядра (з невеликим дебаунсом).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    versionInput.addEventListener('input', () => {
      state.version = versionInput.value.trim();
      state.coreVersion = '';
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void loadCoreVersions(), 350);
    });

    // Початкове наповнення списку версій гри під обране ядро.
    void api
      .metaVersions(state.kind)
      .then((result) => {
        mount(versionDatalist, ...result.versions.map((v) => el('option', { value: v })));
        versionInput.placeholder = result.versions[0] ?? '1.21.8';
        if (result.source === 'fallback') {
          versionHint.textContent =
            'Немає з’єднання з каталогом версій — список неповний, версію можна ввести вручну.';
          versionHint.className = 'mt-1 text-xs text-amber-400';
        } else {
          versionHint.textContent = `Доступно версій: ${result.versions.length} (почніть вводити або оберіть зі списку)`;
        }
        // Якщо версія вже була обрана (повернулися «Назад») — одразу перевіримо ядро.
        if (state.version) void loadCoreVersions();
      })
      .catch(() => {
        versionHint.textContent = 'Не вдалося завантажити список версій — введіть вручну.';
        versionHint.className = 'mt-1 text-xs text-amber-400';
      });

    fillCoreSelect([], null, 'Спершу оберіть версію гри.');

    const nextButton = el('button', {
      class: `${BTN.primary} px-6`,
      text: 'Далі →',
      onClick: () => {
        const version = versionInput.value.trim();
        if (!VERSION_PATTERN.test(version)) {
          showError('Вкажіть коректну версію гри (наприклад, 1.21.8)');
          versionInput.focus();
          return;
        }
        state.version = version;
        state.coreVersion = (coreSelect as HTMLSelectElement).value;
        step = 3;
        render();
      },
    });

    return el(
      'div',
      { class: 'space-y-4' },
      el(
        'div',
        {},
        field(`Версія гри (${state.kind === 'PAPER' ? 'Paper' : 'Fabric'})`, versionInput),
        versionDatalist,
        versionHint,
      ),
      el('div', {}, field(coreLabel, coreSelect), coreHint),
      navButtons(nextButton),
    );
  }

  // ----------------------------------- крок 3: ресурси, порт, підтвердження

  function renderStep3(): HTMLElement {
    // Безпечні дефолти, якщо /api/system ще не відповів.
    const totalMemoryMb = system?.totalMemoryMb ?? 8192;
    const cpuCount = system?.cpuCount ?? 4;
    // Залишаємо ОС щонайменше 1 ГБ, але повзунок не коротший за 1–2 ГБ.
    const memoryMax = Math.max(2048, totalMemoryMb - 1024);
    const memoryMin = 1024;
    state.memoryMb = Math.min(Math.max(state.memoryMb, memoryMin), memoryMax);
    state.cpuCores = Math.min(Math.max(state.cpuCores, 1), cpuCount);

    const formatGb = (mb: number): string =>
      mb % 1024 === 0 ? `${mb / 1024} ГБ` : `${(mb / 1024).toFixed(1)} ГБ`;

    const memoryLabel = el('span', { class: 'text-sm text-zinc-200 font-medium' });
    const memorySlider = el('input', {
      type: 'range',
      class: 'w-full accent-emerald-500',
      min: String(memoryMin),
      max: String(memoryMax),
      step: '512',
      value: String(state.memoryMb),
      onInput: (event) => {
        state.memoryMb = Number((event.target as HTMLInputElement).value);
        updateLabels();
      },
    });

    const cpuLabel = el('span', { class: 'text-sm text-zinc-200 font-medium' });
    const cpuSlider = el('input', {
      type: 'range',
      class: 'w-full accent-emerald-500',
      min: '1',
      max: String(cpuCount),
      step: '1',
      value: String(state.cpuCores),
      onInput: (event) => {
        state.cpuCores = Number((event.target as HTMLInputElement).value);
        updateLabels();
      },
    });

    function updateLabels(): void {
      memoryLabel.textContent = `${formatGb(state.memoryMb)} із ${formatGb(totalMemoryMb)} на ПК`;
      cpuLabel.textContent =
        state.cpuCores >= cpuCount
          ? `усі ${cpuCount} ядер (без обмеження)`
          : `${state.cpuCores} із ${cpuCount} ядер`;
    }
    updateLabels();

    const portInput = el('input', {
      class: INPUT_CLASS,
      type: 'number',
      min: '1024',
      max: '65535',
      value: String(state.hostPort),
      onInput: (event) => {
        state.hostPort = Number((event.target as HTMLInputElement).value);
      },
    });

    const autoStartCheckbox = el('input', {
      type: 'checkbox',
      class: 'accent-emerald-500',
      checked: state.autoStart,
      onChange: (event) => {
        state.autoStart = (event.target as HTMLInputElement).checked;
      },
    });
    const eulaCheckbox = el('input', {
      type: 'checkbox',
      class: 'accent-emerald-500',
      checked: state.acceptEula,
      onChange: (event) => {
        state.acceptEula = (event.target as HTMLInputElement).checked;
      },
    });

    const createButton = el('button', { class: `${BTN.primary} px-6`, text: 'Створити сервер' });
    createButton.addEventListener('click', () => void submit(createButton));

    return el(
      'div',
      { class: 'space-y-4' },
      el(
        'div',
        {},
        el(
          'div',
          { class: 'mb-1 flex items-center justify-between' },
          el('span', { class: 'text-sm text-zinc-400', text: 'Пам’ять (JVM)' }),
          memoryLabel,
        ),
        memorySlider,
      ),
      el(
        'div',
        {},
        el(
          'div',
          { class: 'mb-1 flex items-center justify-between' },
          el('span', { class: 'text-sm text-zinc-400', text: 'Ліміт CPU' }),
          cpuLabel,
        ),
        cpuSlider,
      ),
      field('Порт на цьому комп’ютері', portInput, 'Гравці підключаються до нього'),
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
      navButtons(createButton),
    );
  }

  // ------------------------------------------------------------- створення

  async function submit(button: HTMLButtonElement): Promise<void> {
    clearError();
    if (!Number.isInteger(state.hostPort) || state.hostPort < 1024 || state.hostPort > 65535) {
      showError('Порт має бути числом від 1024 до 65535');
      return;
    }
    if (!state.acceptEula) {
      showError('Потрібно прийняти Minecraft EULA');
      return;
    }

    button.disabled = true;
    try {
      await api.createServer({
        name: state.name,
        kind: state.kind,
        version: state.version,
        coreVersion: state.coreVersion || undefined,
        hostPort: state.hostPort,
        memoryMb: state.memoryMb,
        cpuCores: state.cpuCores,
        acceptEula: true,
        autoStart: state.autoStart,
      });
      close();
      toast('Сервер створюється: образ завантажується у фоні', 'success');
      onCreated();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : 'Не вдалося створити сервер');
    } finally {
      button.disabled = false;
    }
  }

  render();
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
