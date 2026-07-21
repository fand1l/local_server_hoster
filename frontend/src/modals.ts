import { api, ApiError } from './api';
import { el, mount } from './dom';
import { toast } from './toast';
import { BTN, KIND_LABELS } from './ui';
import type { ServerKind, ServerView, SystemInfo } from './types';

/** Загальний каркас модального вікна. Повертає функцію закриття. */
function openModal(title: string, body: HTMLElement): () => void {
  // Закриття з коротким fade-out фону і вікна, потім видалення з DOM.
  const close = (): void => {
    overlay.classList.add('anim-fade-out');
    setTimeout(() => overlay.remove(), 110);
  };

  const overlay = el(
    'div',
    {
      class: 'anim-fade fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4',
      onClick: (event) => {
        if (event.target === overlay) close(); // клік по фону закриває
      },
    },
    el(
      'div',
      {
        class:
          'anim-scale-in w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl ' +
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

/** Ядра, доступні у майстрі. */
const WIZARD_KINDS: Array<{ kind: ServerKind; title: string; description: string }> = [
  {
    kind: 'PAPER',
    title: 'Paper',
    description: 'Рекомендовано: оптимізований, підтримує плагіни',
  },
  {
    kind: 'VANILLA',
    title: 'Vanilla',
    description: 'Чистий офіційний сервер Mojang',
  },
  {
    kind: 'FABRIC',
    title: 'Fabric',
    description: 'Для модів на Fabric Loader',
  },
  {
    kind: 'SPIGOT',
    title: 'Spigot',
    description: 'Класичний сервер із плагінами Bukkit/Spigot',
  },
  {
    kind: 'FORGE',
    title: 'Forge',
    description: 'Для модів на Forge',
  },
  {
    kind: 'NEOFORGE',
    title: 'NeoForge',
    description: 'Сучасний форк Forge (MC 1.20.2+)',
  },
];

/** Підпис поля версії ядра для ядер, що її мають. */
const CORE_LABELS: Partial<Record<ServerKind, string>> = {
  PAPER: 'Білд Paper',
  FABRIC: 'Версія Fabric Loader',
  FORGE: 'Версія Forge',
  NEOFORGE: 'Версія NeoForge',
};

/** Стабільний реліз = лише цифри та крапки (без pre/rc/snapshot/beta). */
const STABLE_VERSION_PATTERN = /^[0-9.]+$/;

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
  onlineMode: boolean;
  /** 0 = прегенерація вимкнена; інакше — радіус у блоках. */
  pregenRadius: number;
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
    onlineMode: true,
    pregenRadius: 0,
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
    // Кожен крок м'яко «виїжджає» знизу — швидкий перехід між кроками майстра.
    content.classList.add('anim-fade-up');
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
            'h-full w-full rounded-xl border p-3 text-left transition-colors ' +
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
        el('div', { class: 'grid grid-cols-2 gap-2' }, ...kindCards),
      ),
      navButtons(nextButton),
    );
  }

  // ------------------------------------ крок 2: версія гри ↔ версія ядра

  function renderStep2(): HTMLElement {
    const hasCoreVersion = state.kind !== 'VANILLA' && state.kind !== 'SPIGOT';

    let allVersions: string[] = [];
    let versionsSource: 'online' | 'fallback' | 'loading' = 'loading';
    let showUnstable = false;
    // Фільтруємо список за текстом ЛИШЕ коли користувач набирає. Коли в полі вже
    // стоїть обрана версія (напр. «26.2») — при повторному відкритті показуємо всі,
    // інакше вибрана версія «залипає» фільтром і не дає обрати іншу, поки не стерти.
    let filtering = false;
    const isStable = (v: string): boolean => STABLE_VERSION_PATTERN.test(v);

    const versionInput = el('input', {
      class: INPUT_CLASS,
      type: 'text',
      placeholder: 'Завантаження списку…',
      value: state.version,
      spellcheck: 'false',
      autocomplete: 'off',
    });
    // Власний випадний список замість <datalist>: браузерний неможливо ані
    // обмежити за висотою, ані відфільтрувати від снапшотів (див. issue у чаті).
    const dropdown = el('div', {
      class:
        'anim-scale-in absolute left-0 right-0 top-full z-20 mt-1 hidden max-h-56 overflow-y-auto ' +
        'thin-scroll origin-top rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl',
    });
    const comboWrap = el('div', { class: 'relative' }, versionInput, dropdown);
    const versionHint = el('p', { class: 'mt-1 text-xs text-zinc-500', text: '' });

    // Mousedown поза комбобоксом миттєво закриває список: інакше відкритий
    // dropdown перехоплює перший клік по елементах під ним («Назад»/«Далі»).
    body.addEventListener('mousedown', (event) => {
      if (!comboWrap.contains(event.target as Node)) hideDropdown();
    });

    const unstableToggle = el('input', {
      type: 'checkbox',
      class: 'accent-emerald-500',
      onChange: (event) => {
        showUnstable = (event.target as HTMLInputElement).checked;
        // Активація чекбокса забирає фокус в інпута — повертаємо, щоб
        // blur-обробник не закрив список одразу після перемикання.
        versionInput.focus();
        refreshDropdown(true);
        updateVersionHint();
      },
    });
    // Перемикач живе ПРИФІКСОВАНИМ рядком усередині випадного списку: якби він
    // стояв під інпутом, відкритий список його б перекривав.
    const unstableToggleRow = el(
      'label',
      {
        class:
          'sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 ' +
          'px-3 py-1.5 text-xs text-zinc-400 cursor-pointer',
      },
      unstableToggle,
      'тестові версії (snapshot / pre / rc)',
    );
    // mousedown гасимо, щоб інпут не втратив фокус і список не закрився.
    unstableToggleRow.addEventListener('mousedown', (event) => event.preventDefault());

    function visibleVersions(): string[] {
      // Порожній query, коли не в режимі набору → показуємо весь список.
      const query = filtering ? versionInput.value.trim().toLowerCase() : '';
      return allVersions.filter(
        (v) => (showUnstable || isStable(v)) && v.toLowerCase().includes(query),
      );
    }

    function hideDropdown(): void {
      dropdown.classList.add('hidden');
    }

    function refreshDropdown(show: boolean): void {
      const pool = visibleVersions().slice(0, 30);
      const current = versionInput.value.trim();
      const items = pool.map((version) => {
        const selected = version === current;
        const item = el('button', {
          type: 'button',
          class:
            'block w-full px-3 py-1.5 text-left text-sm hover:bg-emerald-950/50 ' +
            // Підсвічуємо поточний вибір, щоб було видно, де ти у списку.
            (selected ? 'bg-emerald-950/40 font-medium text-emerald-300' : 'text-zinc-200'),
          text: version,
        });
        // mousedown, а не click: спрацьовує до blur інпута, інакше список
        // встигає сховатися раніше за вибір.
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pickVersion(version);
        });
        return item;
      });
      mount(
        dropdown,
        unstableToggleRow,
        ...(items.length > 0
          ? items
          : [
              el('div', {
                class: 'px-3 py-2 text-xs text-zinc-500',
                text:
                  versionsSource === 'loading'
                    ? 'Список ще завантажується…'
                    : 'Збігів немає — версію можна ввести вручну',
              }),
            ]),
      );
      dropdown.classList.toggle('hidden', !show);
    }

    function pickVersion(version: string): void {
      versionInput.value = version;
      state.version = version;
      state.coreVersion = '';
      filtering = false; // вибір завершено — наступне відкриття покаже весь список
      hideDropdown();
      void loadCoreVersions();
    }

    function updateVersionHint(): void {
      if (versionsSource === 'loading') {
        versionHint.textContent = '';
        return;
      }
      if (versionsSource === 'fallback') {
        versionHint.textContent =
          'Немає з’єднання з каталогом версій — список неповний, версію можна ввести вручну.';
        versionHint.className = 'mt-1 text-xs text-amber-400';
        return;
      }
      const stableCount = allVersions.filter(isStable).length;
      versionHint.className = 'mt-1 text-xs text-zinc-500';
      versionHint.textContent = showUnstable
        ? `Доступно версій: ${allVersions.length} (разом із тестовими)`
        : `Доступно стабільних версій: ${stableCount} (усього ${allVersions.length})`;
    }

    // Відкриваємо список у режимі перегляду: повний список + виділений текст,
    // щоб перший символ замінив стару версію (не треба стирати вручну).
    function openForBrowsing(): void {
      filtering = false;
      // Виділення відкладаємо у наступний кадр: якщо викликати select() прямо тут,
      // браузер після обробки focus сам ставить каретку в кінець і скидає виділення.
      requestAnimationFrame(() => {
        if (document.activeElement === versionInput) versionInput.select();
      });
      refreshDropdown(true);
    }

    versionInput.addEventListener('focus', openForBrowsing);
    // Клік потрібен окремо: після вибору пункту поле лишається сфокусованим
    // (mousedown по пункту гаситься preventDefault), тож focus повторно НЕ
    // спрацьовує — і без цього обробника список не перевідкривався б зі свіжим
    // значенням (саме той баг, коли обрана версія «залипала» фільтром).
    versionInput.addEventListener('click', openForBrowsing);
    versionInput.addEventListener('blur', () =>
      setTimeout(() => {
        // Якщо фокус повернувся (перемикач у списку) — список лишається відкритим.
        if (document.activeElement !== versionInput) hideDropdown();
      }, 150),
    );
    versionInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') hideDropdown();
    });

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
      if (!hasCoreVersion) return; // Vanilla / Spigot — окремої версії ядра немає
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
          fillCoreSelect(
            [],
            null,
            `Для ${gameVersion} ще немає збірок ${KIND_LABELS[state.kind]} — оберіть іншу версію гри.`,
          );
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

    // Зміна версії гри → фільтрація списку + перезапит сумісних версій ядра.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    versionInput.addEventListener('input', () => {
      state.version = versionInput.value.trim();
      state.coreVersion = '';
      filtering = true; // почали набирати — тепер текст фільтрує список
      refreshDropdown(true);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void loadCoreVersions(), 350);
    });

    // Початкове наповнення списку версій гри під обране ядро.
    void api
      .metaVersions(state.kind)
      .then((result) => {
        allVersions = result.versions;
        versionsSource = result.source;
        versionInput.placeholder =
          result.versions.find((v) => isStable(v)) ?? result.versions[0] ?? '26.2';
        updateVersionHint();
        refreshDropdown(document.activeElement === versionInput);
        // Якщо версія вже була обрана (повернулися «Назад») — одразу перевіримо ядро.
        if (state.version) void loadCoreVersions();
      })
      .catch(() => {
        versionsSource = 'fallback';
        versionHint.textContent = 'Не вдалося завантажити список версій — введіть вручну.';
        versionHint.className = 'mt-1 text-xs text-amber-400';
      });

    if (hasCoreVersion) fillCoreSelect([], null, 'Спершу оберіть версію гри.');

    const nextButton = el('button', {
      class: `${BTN.primary} px-6`,
      text: 'Далі →',
      onClick: () => {
        const version = versionInput.value.trim();
        if (!VERSION_PATTERN.test(version)) {
          showError('Вкажіть коректну версію гри (наприклад, 26.2 або 1.21.8)');
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
        // Не <label>: клік по пунктах випадного списку не має фокусувати інпут.
        el('span', {
          class: 'mb-1 block text-sm text-zinc-400',
          text: `Версія гри (${KIND_LABELS[state.kind]})`,
        }),
        comboWrap,
        versionHint,
      ),
      hasCoreVersion
        ? el('div', {}, field(CORE_LABELS[state.kind] ?? 'Версія ядра', coreSelect), coreHint)
        : el('p', {
            class: 'text-xs text-zinc-500',
            text: `${KIND_LABELS[state.kind]} не потребує окремої версії ядра — збірка визначається версією гри.`,
          }),
      navButtons(nextButton),
    );
  }

  /**
   * Блок автопрегенерації: запитує в бекенда, чи є сумісна збірка Chunky для
   * обраного ядра+версії. Якщо є — показує чекбокс і поле радіуса з підказкою;
   * якщо ні (Vanilla, немає збірки, немає мережі) — пояснює, чому недоступно.
   */
  function renderPregenBlock(slot: HTMLElement): void {
    mount(
      slot,
      el('p', { class: 'text-xs text-zinc-500', text: 'Перевірка доступності прегенерації світу…' }),
    );

    void api
      .metaPregen(state.kind, state.version)
      .then((result) => {
        if (!result.available) {
          state.pregenRadius = 0;
          mount(
            slot,
            el('p', {
              class: 'text-xs text-zinc-500',
              text: `Автопрегенерація недоступна: ${result.reason ?? 'немає сумісної збірки Chunky'}`,
            }),
          );
          return;
        }

        const radiusInput = el('input', {
          class: INPUT_CLASS,
          type: 'number',
          min: '100',
          max: '50000',
          step: '100',
          value: String(state.pregenRadius > 0 ? state.pregenRadius : 3000),
          onInput: (event) => {
            state.pregenRadius = Number((event.target as HTMLInputElement).value);
            updatePregenTip();
          },
        });
        const pregenTip = el('p', { class: 'mt-1 text-xs text-zinc-500' });

        function updatePregenTip(): void {
          const r = state.pregenRadius > 0 ? state.pregenRadius : 3000;
          // Chunky рахує радіус у блоках від центру світу; квадратна область.
          const sideBlocks = r * 2;
          const chunks = Math.round((sideBlocks / 16) ** 2);
          const minutesRough = Math.max(1, Math.round(chunks / 8000)); // ~груба оцінка
          pregenTip.textContent =
            `Радіус — у БЛОКАХ від центру світу. ${r} блоків = область ${sideBlocks}×${sideBlocks} ` +
            `(~${chunks.toLocaleString('uk')} чанків, орієнтовно ~${minutesRough} хв генерації). ` +
            `Більший радіус = менше лагів у грі, але довша разова генерація.`;
        }

        const radiusField = el(
          'div',
          { class: state.pregenRadius > 0 ? 'mt-2' : 'mt-2 hidden' },
          el('span', { class: 'mb-1 block text-sm text-zinc-400', text: 'Радіус прегенерації (блоки)' }),
          radiusInput,
          pregenTip,
        );
        updatePregenTip();

        const toggle = el('input', {
          type: 'checkbox',
          class: 'accent-emerald-500',
          checked: state.pregenRadius > 0,
          onChange: (event) => {
            const on = (event.target as HTMLInputElement).checked;
            state.pregenRadius = on ? Number(radiusInput.value) || 3000 : 0;
            radiusField.classList.toggle('hidden', !on);
          },
        });

        mount(
          slot,
          el(
            'label',
            { class: 'flex items-center gap-2 text-sm text-zinc-300' },
            toggle,
            'Автоматична прегенерація світу (Chunky)',
          ),
          el('p', {
            class: 'mt-1 text-xs text-zinc-500',
            text: 'Згенерує чанки навколо спавна одразу після запуску — прибирає лаги підвантаження під час гри. Триває один раз.',
          }),
          radiusField,
        );
      })
      .catch(() => {
        state.pregenRadius = 0;
        mount(
          slot,
          el('p', { class: 'text-xs text-zinc-500', text: 'Не вдалося перевірити доступність прегенерації.' }),
        );
      });
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

    // Онлайн-режим (ліцензія): увімкнено = лише офіційні акаунти Mojang/Microsoft.
    const onlineModeCheckbox = el('input', {
      type: 'checkbox',
      class: 'accent-emerald-500',
      checked: state.onlineMode,
      onChange: (event) => {
        state.onlineMode = (event.target as HTMLInputElement).checked;
        onlineModeHint.textContent = state.onlineMode
          ? 'Лише ліцензійні акаунти. Голови скінів гравців працюють.'
          : 'Офлайн-режим: пускає піратські клієнти. Скіни й перевірка акаунтів вимкнені, UUID нестабільні.';
      },
    });
    const onlineModeHint = el('span', {
      class: 'mt-1 block text-xs text-zinc-500',
      text: 'Лише ліцензійні акаунти. Голови скінів гравців працюють.',
    });

    // Блок автопрегенерації Chunky: показуємо лише коли Modrinth підтвердив
    // сумісність із обраним ядром+версією (перевірка на кроці 2 недосяжна — версія
    // остаточна лише тут).
    const pregenSlot = el('div', {
      class: 'rounded-lg border border-zinc-800 bg-zinc-950/40 p-3',
    });
    renderPregenBlock(pregenSlot);

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
        'div',
        {},
        el(
          'label',
          { class: 'flex items-center gap-2 text-sm text-zinc-300' },
          onlineModeCheckbox,
          'Тільки ліцензійні акаунти (online-mode)',
        ),
        onlineModeHint,
      ),
      pregenSlot,
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
        onlineMode: state.onlineMode,
        pregenRadius: state.pregenRadius > 0 ? state.pregenRadius : undefined,
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
