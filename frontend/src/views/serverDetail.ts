import { api, ApiError } from '../api';
import { el, mount } from '../dom';
import { openDeleteServerModal } from '../modals';
import { toast } from '../toast';
import { BTN, chip, coreVersionChipText, formatMemory, KIND_LABELS, statusBadge, withButtonLock } from '../ui';
import { ConsoleConnection } from '../ws';
import type { PropertyEntry, ServerView } from '../types';

const REFRESH_INTERVAL_MS = 3000;
/** Обмеження буфера консолі, щоб вкладка не з'їдала пам'ять на добових логах. */
const CONSOLE_BUFFER_MAX_CHARS = 500_000;
const CONSOLE_BUFFER_KEEP_CHARS = 350_000;

/** Сторінка сервера: заголовок з діями + вкладки "Консоль" і "server.properties". */
export function renderServerDetail(root: HTMLElement, serverId: string): () => void {
  let server: ServerView | null = null;
  let activeTab: 'console' | 'properties' | 'settings' = 'console';

  // ------------------------------------------------------------- заголовок

  const titleEl = el('h1', { class: 'text-xl font-semibold text-zinc-100', text: '…' });
  const badgeSlot = el('span', {});
  const chipsRow = el('div', { class: 'flex flex-wrap gap-1.5' });
  const detailLine = el('p', { class: 'text-xs text-zinc-500 break-words' });
  const addressLine = el('p', { class: 'text-sm text-zinc-400' });

  const startButton = el('button', { class: BTN.primary, text: 'Запустити' });
  const stopButton = el('button', { class: BTN.neutral, text: 'Зупинити' });
  const restartButton = el('button', { class: BTN.neutral, text: 'Рестарт' });
  const deleteButton = el('button', { class: BTN.danger, text: 'Видалити' });

  startButton.addEventListener('click', () =>
    withButtonLock(startButton, () => lifecycleAction(() => api.startServer(serverId))),
  );
  stopButton.addEventListener('click', () =>
    withButtonLock(stopButton, () => lifecycleAction(() => api.stopServer(serverId))),
  );
  restartButton.addEventListener('click', () =>
    withButtonLock(restartButton, () => lifecycleAction(() => api.restartServer(serverId))),
  );
  deleteButton.addEventListener('click', () => {
    if (server) {
      openDeleteServerModal(server, () => {
        location.hash = '#/';
      });
    }
  });

  // --------------------------------------------------------------- консоль

  const consoleOutput = el('div', {
    class:
      'console-output thin-scroll h-[26rem] overflow-y-auto rounded-lg border border-zinc-800 ' +
      'bg-black/70 p-3 text-zinc-200',
  });
  let consoleLength = 0;

  const connectionState = el('span', { class: 'text-xs text-zinc-500', text: 'підключення…' });

  const commandInput = el('input', {
    class:
      'flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm ' +
      'text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none',
    type: 'text',
    placeholder: 'Команда серверу, наприклад: say Привіт | list | op Гравець',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const sendButton = el('button', { class: BTN.primary, text: 'Надіслати' });

  // Історія введених команд (стрілки вгору/вниз, як у терміналі).
  const commandHistory: string[] = [];
  let historyCursor = -1;

  function appendToConsole(text: string): void {
    // Автопрокрутка лише якщо користувач і так дивиться на "хвіст" логу.
    const pinned =
      consoleOutput.scrollTop + consoleOutput.clientHeight >= consoleOutput.scrollHeight - 48;

    consoleOutput.append(document.createTextNode(text));
    consoleLength += text.length;
    if (consoleLength > CONSOLE_BUFFER_MAX_CHARS) {
      const trimmed = (consoleOutput.textContent ?? '').slice(-CONSOLE_BUFFER_KEEP_CHARS);
      consoleOutput.textContent = trimmed;
      consoleLength = trimmed.length;
    }
    if (pinned) consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  const connection = new ConsoleConnection(serverId, {
    onMessage(message) {
      switch (message.type) {
        case 'log':
          appendToConsole(message.data);
          break;
        case 'info':
          appendToConsole(`ℹ ${message.message}\n`);
          break;
        case 'error':
          appendToConsole(`✖ ${message.message}\n`);
          break;
        case 'status':
          void refresh(); // стан змінився — оновлюємо заголовок без очікування полінгу
          break;
      }
    },
    onConnectionChange(state) {
      connectionState.textContent =
        state === 'open'
          ? 'консоль підключена'
          : state === 'connecting'
            ? 'підключення…'
            : 'з’єднання втрачено, перепідключення…';
    },
  });

  function sendCommand(): void {
    const command = commandInput.value.trim();
    if (!command) return;
    if (!connection.send(command)) {
      toast('Консоль не підключена', 'error');
      return;
    }
    commandHistory.push(command);
    historyCursor = commandHistory.length;
    commandInput.value = '';
  }

  sendButton.addEventListener('click', sendCommand);
  commandInput.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Enter') {
      event.preventDefault();
      sendCommand();
    } else if (key === 'ArrowUp' && commandHistory.length > 0) {
      event.preventDefault();
      historyCursor = Math.max(0, historyCursor - 1);
      commandInput.value = commandHistory[historyCursor] ?? '';
    } else if (key === 'ArrowDown' && commandHistory.length > 0) {
      event.preventDefault();
      historyCursor = Math.min(commandHistory.length, historyCursor + 1);
      commandInput.value = commandHistory[historyCursor] ?? '';
    }
  });

  const consolePanel = el(
    'div',
    { class: 'space-y-2' },
    consoleOutput,
    el('div', { class: 'flex items-center gap-2' }, commandInput, sendButton),
    connectionState,
  );

  // ------------------------------------------------------ server.properties

  const propertiesPanel = el('div', { class: 'space-y-3' });
  let propertiesLoaded = false;

  async function loadProperties(): Promise<void> {
    mount(propertiesPanel, el('p', { class: 'text-sm text-zinc-500', text: 'Завантаження…' }));
    try {
      const state = await api.getProperties(serverId);
      renderProperties(state.exists, state.entries, state.warning);
      propertiesLoaded = true;
    } catch (err) {
      mount(
        propertiesPanel,
        el('p', {
          class: 'text-sm text-red-400',
          text: err instanceof ApiError ? err.message : 'Не вдалося завантажити налаштування',
        }),
        el('button', { class: BTN.neutral, text: 'Спробувати ще раз', onClick: () => void loadProperties() }),
      );
    }
  }

  function renderProperties(exists: boolean, entries: PropertyEntry[], warning: string | null): void {
    if (!exists) {
      mount(
        propertiesPanel,
        el(
          'div',
          { class: 'rounded-xl border border-dashed border-zinc-800 p-8 text-center text-zinc-500' },
          el('p', { class: 'mb-2', text: 'Файл server.properties ще не створено.' }),
          el('p', {
            class: 'mb-4 text-sm',
            text: 'Запустіть сервер один раз — Minecraft згенерує файл, і його можна буде редагувати тут.',
          }),
          el('button', { class: BTN.neutral, text: 'Перевірити ще раз', onClick: () => void loadProperties() }),
        ),
      );
      return;
    }

    // key → поле вводу; збираємо значення при збереженні.
    const inputByKey = new Map<string, HTMLInputElement | HTMLSelectElement>();

    const rows = entries.map((entry) => {
      const isPort = entry.key === 'server-port';
      const isBoolean = entry.value === 'true' || entry.value === 'false';

      const valueControl: HTMLInputElement | HTMLSelectElement = isBoolean
        ? el(
            'select',
            { class: propertyInputClass(false), disabled: isPort },
            el('option', { value: 'true', text: 'true', selected: entry.value === 'true' }),
            el('option', { value: 'false', text: 'false', selected: entry.value === 'false' }),
          )
        : el('input', {
            class: propertyInputClass(isPort),
            type: 'text',
            value: entry.value,
            disabled: isPort,
            spellcheck: 'false',
          });

      inputByKey.set(entry.key, valueControl);

      return el(
        'div',
        { class: 'flex items-center gap-3 border-b border-zinc-800/70 py-1.5 last:border-b-0' },
        el('code', {
          class: 'w-56 shrink-0 truncate text-xs text-zinc-400',
          text: entry.key,
          title: isPort
            ? 'Порт усередині контейнера керується панеллю: назовні прокинуто порт сервера'
            : entry.key,
        }),
        valueControl,
      );
    });

    const saveButton = el('button', { class: BTN.primary, text: 'Зберегти зміни' });
    saveButton.addEventListener('click', () =>
      withButtonLock(saveButton, async () => {
        const updates: PropertyEntry[] = [];
        for (const [key, control] of inputByKey) {
          if (control.disabled) continue;
          updates.push({ key, value: control.value });
        }
        try {
          const state = await api.saveProperties(serverId, updates);
          toast('server.properties збережено', 'success');
          if (state.warning) toast(state.warning, 'info');
          renderProperties(state.exists, state.entries, state.warning);
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Не вдалося зберегти', 'error');
        }
      }),
    );

    mount(
      propertiesPanel,
      warning
        ? el('p', {
            class:
              'rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300',
            text: warning,
          })
        : null,
      el(
        'div',
        {
          class:
            'thin-scroll max-h-[26rem] overflow-y-auto rounded-lg border border-zinc-800 ' +
            'bg-zinc-900/40 px-4 py-2',
        },
        ...rows,
      ),
      el(
        'div',
        { class: 'flex items-center gap-2' },
        saveButton,
        el('button', { class: BTN.neutral, text: 'Оновити з файлу', onClick: () => void loadProperties() }),
      ),
    );
  }

  function propertyInputClass(disabled: boolean): string {
    return (
      'flex-1 rounded-md border border-zinc-700/70 bg-zinc-950 px-2 py-1 font-mono text-xs ' +
      'text-zinc-100 focus:border-emerald-500 focus:outline-none ' +
      (disabled ? 'opacity-50 cursor-not-allowed' : '')
    );
  }

  // --------------------------------------------------------------- параметри

  const settingsPanel = el('div', { class: 'space-y-4' });

  /** Вкладка редагування: назва — будь-коли, ресурси — лише на зупиненому сервері. */
  function renderSettings(): void {
    const current = server;
    if (!current) {
      mount(settingsPanel, el('p', { class: 'text-sm text-zinc-500', text: 'Завантаження…' }));
      return;
    }

    mount(settingsPanel, el('p', { class: 'text-sm text-zinc-500', text: 'Завантаження меж ресурсів…' }));

    void api
      .system()
      .catch(() => null)
      .then((system) => {
        const totalMemoryMb = system?.totalMemoryMb ?? 8192;
        const cpuCount = system?.cpuCount ?? 4;
        const memoryMax = Math.max(2048, totalMemoryMb - 1024);
        const resourcesLocked = current.runtime === 'running' || current.runtime === 'creating';

        let memoryMb = Math.min(Math.max(current.memoryMb, 1024), memoryMax);
        // Повзунок на максимумі = «без ліміту CPU» (надсилаємо null).
        let cpuValue = current.cpuCores === null ? cpuCount : Math.min(current.cpuCores, cpuCount);

        const nameInput = el('input', {
          class:
            'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ' +
            'focus:border-emerald-500 focus:outline-none',
          type: 'text',
          value: current.name,
        });

        const formatGb = (mb: number): string =>
          mb % 1024 === 0 ? `${mb / 1024} ГБ` : `${(mb / 1024).toFixed(1)} ГБ`;

        const memoryLabel = el('span', { class: 'text-sm font-medium text-zinc-200' });
        const memorySlider = el('input', {
          type: 'range',
          class: 'w-full accent-emerald-500 disabled:opacity-40',
          min: '1024',
          max: String(memoryMax),
          step: '512',
          value: String(memoryMb),
          disabled: resourcesLocked,
          onInput: (event) => {
            memoryMb = Number((event.target as HTMLInputElement).value);
            updateLabels();
          },
        });

        const cpuLabel = el('span', { class: 'text-sm font-medium text-zinc-200' });
        const cpuSlider = el('input', {
          type: 'range',
          class: 'w-full accent-emerald-500 disabled:opacity-40',
          min: '1',
          max: String(cpuCount),
          step: '1',
          value: String(cpuValue),
          disabled: resourcesLocked,
          onInput: (event) => {
            cpuValue = Number((event.target as HTMLInputElement).value);
            updateLabels();
          },
        });

        function updateLabels(): void {
          memoryLabel.textContent = `${formatGb(memoryMb)} із ${formatGb(totalMemoryMb)}`;
          cpuLabel.textContent =
            cpuValue >= cpuCount ? `усі ${cpuCount} ядер (без ліміту)` : `${cpuValue} із ${cpuCount} ядер`;
        }
        updateLabels();

        const saveButton = el('button', { class: BTN.primary, text: 'Зберегти зміни' });
        saveButton.addEventListener('click', () =>
          withButtonLock(saveButton, async () => {
            try {
              const patch: Parameters<typeof api.updateServer>[1] = { name: nameInput.value.trim() };
              if (!resourcesLocked) {
                patch.memoryMb = memoryMb;
                patch.cpuCores = cpuValue >= cpuCount ? null : cpuValue;
              }
              applyServer(await api.updateServer(serverId, patch));
              toast('Налаштування збережено', 'success');
              renderSettings(); // перерендер зі свіжими значеннями/станом
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Не вдалося зберегти', 'error');
            }
          }),
        );

        mount(
          settingsPanel,
          resourcesLocked
            ? el('p', {
                class:
                  'rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300',
                text: 'Сервер запущено: назву можна змінити зараз, а ресурси — лише після зупинки (потрібне перестворення контейнера).',
              })
            : el('p', {
                class: 'text-xs text-zinc-500',
                text: 'Зміна ресурсів перестворює контейнер із новими лімітами. Файли світу при цьому не зачіпаються.',
              }),
          el(
            'label',
            { class: 'block' },
            el('span', { class: 'mb-1 block text-sm text-zinc-400', text: 'Назва сервера' }),
            nameInput,
          ),
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
          saveButton,
        );
      });
  }

  // ---------------------------------------------------------------- вкладки

  const consoleTabButton = el('button', { text: 'Консоль' });
  const propertiesTabButton = el('button', { text: 'server.properties' });
  const settingsTabButton = el('button', { text: 'Параметри' });
  const tabPanelSlot = el('div', {});

  function tabClass(active: boolean): string {
    return (
      'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
      (active
        ? 'border-emerald-500 text-emerald-400'
        : 'border-transparent text-zinc-500 hover:text-zinc-300')
    );
  }

  function selectTab(tab: 'console' | 'properties' | 'settings'): void {
    activeTab = tab;
    consoleTabButton.className = tabClass(tab === 'console');
    propertiesTabButton.className = tabClass(tab === 'properties');
    settingsTabButton.className = tabClass(tab === 'settings');
    mount(
      tabPanelSlot,
      tab === 'console' ? consolePanel : tab === 'properties' ? propertiesPanel : settingsPanel,
    );
    if (tab === 'properties' && !propertiesLoaded) void loadProperties();
    if (tab === 'settings') renderSettings();
  }

  consoleTabButton.addEventListener('click', () => selectTab('console'));
  propertiesTabButton.addEventListener('click', () => selectTab('properties'));
  settingsTabButton.addEventListener('click', () => selectTab('settings'));

  // ------------------------------------------------------------- складання

  mount(
    root,
    el('a', {
      class: 'mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-300',
      text: '← Усі сервери',
      href: '#/',
    }),
    el(
      'div',
      { class: 'mb-4 flex flex-wrap items-start justify-between gap-3' },
      el(
        'div',
        { class: 'space-y-1.5' },
        el('div', { class: 'flex items-center gap-3' }, titleEl, badgeSlot),
        chipsRow,
        addressLine,
        detailLine,
      ),
      el('div', { class: 'flex flex-wrap gap-2' }, startButton, stopButton, restartButton, deleteButton),
    ),
    el(
      'div',
      { class: 'mb-4 flex border-b border-zinc-800' },
      consoleTabButton,
      propertiesTabButton,
      settingsTabButton,
    ),
    tabPanelSlot,
  );

  selectTab('console');
  connection.connect();

  // ------------------------------------------------------------- оновлення

  function applyServer(view: ServerView): void {
    server = view;
    titleEl.textContent = view.name;
    mount(badgeSlot, statusBadge(view));
    mount(
      chipsRow,
      chip(KIND_LABELS[view.kind]),
      chip(view.version, 'Версія Minecraft'),
      view.coreVersion
        ? chip(coreVersionChipText(view.kind, view.coreVersion), 'Версія ядра')
        : null,
      chip(formatMemory(view.memoryMb), 'Пам’ять JVM'),
      view.cpuCores ? chip(`${view.cpuCores} CPU`, 'Ліміт CPU') : null,
    );
    addressLine.textContent =
      view.runtime === 'running'
        ? `Адреса для підключення: localhost:${view.hostPort} (у локальній мережі — IP цього комп'ютера)`
        : `Порт для гравців: ${view.hostPort}`;
    detailLine.textContent = view.runtimeDetail ?? view.statusDetail ?? '';

    startButton.disabled = !(view.runtime === 'stopped' || view.runtime === 'error');
    stopButton.disabled = view.runtime !== 'running';
    restartButton.disabled = view.runtime !== 'running';
    deleteButton.disabled = view.runtime === 'creating';

    const consoleReady = view.runtime === 'running';
    commandInput.disabled = !consoleReady;
    sendButton.disabled = !consoleReady;
  }

  async function lifecycleAction(action: () => Promise<ServerView>): Promise<void> {
    try {
      applyServer(await action());
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Операція не вдалася', 'error');
      await refresh();
    }
  }

  async function refresh(): Promise<void> {
    try {
      applyServer(await api.getServer(serverId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast('Сервер не знайдено', 'error');
        location.hash = '#/';
      }
    }
  }

  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    connection.close();
  };
}
