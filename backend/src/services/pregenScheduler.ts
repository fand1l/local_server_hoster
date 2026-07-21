import { setTimeout as sleep } from 'node:timers/promises';
import type { ContainerManager } from '../docker/containerManager.js';
import type { ConsoleGateway } from '../docker/consoleGateway.js';
import type { ServerRecord } from '../types.js';
import type { Logger } from './serverService.js';

/**
 * Автоматична прегенерація світу через Chunky.
 *
 * Ідея: важка генерація чанків, що зазвичай викликає лаги при дослідженні світу,
 * виконується один раз одразу після першого запуску сервера. Коли контейнер
 * повністю піднявся (RCON відповідає на `list`), надсилаємо:
 *   chunky radius <blocks>
 *   chunky start
 * Chunky пише прогрес у консоль сервера (яку користувач бачить у панелі).
 *
 * Готовність визначаємо RCON-пробою, а не парсингом рядка "Done" — формат
 * стартового повідомлення різниться між ядрами й версіями, а `list` відповідає
 * стабільно на всіх шістьох ядрах.
 */

/** Скільки максимум чекати повного старту сервера (перший запуск + встановлення Chunky). */
const READINESS_TIMEOUT_MS = 8 * 60 * 1000;
const READINESS_POLL_MS = 5000;

interface PregenSchedulerDeps {
  containers: ContainerManager;
  gateway: ConsoleGateway;
  /** Завжди свіжий запис (containerId міг змінитися після перестворення). */
  getRecord: (id: string) => ServerRecord | null;
  /** Позначити прегенерацію як виконану, щоб не запускати її повторно. */
  markDone: (id: string) => void;
  log: Logger;
}

export class PregenScheduler {
  private readonly deps: PregenSchedulerDeps;
  /** Сервери, для яких прегенерація зараз у процесі очікування/запуску. */
  private readonly active = new Set<string>();

  constructor(deps: PregenSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Планує прегенерацію після старту сервера. Нічого не робить, якщо прегенерація
   * не налаштована, вже виконана або вже триває. Не блокує виклик (fire-and-forget).
   */
  schedule(record: ServerRecord): void {
    if (!record.pregenRadius || record.pregenDone) return;
    if (this.active.has(record.id)) return;
    this.active.add(record.id);
    void this.run(record.id).finally(() => this.active.delete(record.id));
  }

  private async run(serverId: string): Promise<void> {
    const record = this.deps.getRecord(serverId);
    if (!record?.containerId || !record.pregenRadius || record.pregenDone) return;

    const ready = await this.waitUntilReady(serverId);
    if (!ready) {
      this.deps.gateway.notifyInfo(
        serverId,
        'Прегенерацію скасовано: сервер не вийшов у робочий стан вчасно.',
      );
      return;
    }

    // Перечитуємо запис: за час очікування сервер могли зупинити/видалити.
    const fresh = this.deps.getRecord(serverId);
    if (!fresh?.containerId || !fresh.pregenRadius || fresh.pregenDone) return;

    try {
      this.deps.gateway.notifyInfo(
        serverId,
        `Запускаю автопрегенерацію Chunky (радіус ${fresh.pregenRadius} блоків)…`,
      );
      // Радіус (у блоках від центру світу) + старт. rcon-cli вбудований в образ.
      const setRadius = await this.deps.containers.execCapture(fresh.containerId, [
        'rcon-cli',
        'chunky',
        'radius',
        String(fresh.pregenRadius),
      ]);
      // Якщо команди chunky немає (Chunky не встановився) — не крутимо марно.
      if (/unknown|not found|немає такої команди/i.test(setRadius.output)) {
        this.deps.gateway.notifyInfo(
          serverId,
          'Команда chunky недоступна (плагін/мод не завантажився) — автопрегенерацію пропущено.',
        );
        this.deps.markDone(serverId); // не повторюємо щозапуску
        return;
      }
      await this.deps.containers.execCapture(fresh.containerId, ['rcon-cli', 'chunky', 'start']);

      // Позначаємо як зроблене одразу після старту: сама генерація триває у фоні
      // на сервері й переживе рестарт панелі (Chunky зберігає прогрес).
      this.deps.markDone(serverId);
      this.deps.gateway.notifyInfo(
        serverId,
        'Прегенерацію запущено. Прогрес видно у консолі; сервер уже можна використовувати.',
      );
      this.deps.log.info(`Прегенерацію Chunky запущено для сервера ${serverId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.gateway.notifyInfo(serverId, `Не вдалося запустити прегенерацію: ${message}`);
      this.deps.log.warn(`Прегенерація сервера ${serverId} не вдалася: ${message}`);
    }
  }

  /** Чекає, поки сервер почне відповідати на RCON `list` (ознака повного старту). */
  private async waitUntilReady(serverId: string): Promise<boolean> {
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = this.deps.getRecord(serverId);
      // Сервер зник/зупинився/прегенерацію вже зробили іншим шляхом — виходимо.
      if (!record?.containerId || record.pregenDone) return false;

      const state = await this.deps.containers.inspectState(record.containerId).catch(() => null);
      if (!state?.running) return false;

      try {
        const result = await this.deps.containers.execCapture(
          record.containerId,
          ['rcon-cli', 'list'],
          5000,
        );
        if (result.exitCode === 0 && /online/i.test(result.output)) return true;
      } catch {
        // RCON ще не піднявся — чекаємо далі.
      }
      await sleep(READINESS_POLL_MS);
    }
    return false;
  }
}
