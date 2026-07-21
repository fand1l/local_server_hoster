import type { ContainerManager } from '../docker/containerManager.js';
import { parseChunkyLine } from '../minecraft/chunkyProgress.js';
import type { PregenProgress, ServerRecord } from '../types.js';

/**
 * Фоновий монітор прогресу прегенерації Chunky.
 *
 * Для кожного запущеного сервера з увімкненою прегенерацією відкриває власний
 * потік логів (незалежно від того, чи відкрита консоль у браузері), парсить
 * рядки `[Chunky] … Processed: N chunks (X%) …` і тримає останній стан у пам'яті.
 * Цей стан потрапляє у ServerView (для картки на дашборді) і пушиться в консоль
 * через колбек onUpdate (для живого бару над терміналом).
 *
 * Стан ефемерний: після рестарту панелі монітор перепідключається і швидко
 * відновлює прогрес із «хвоста» логів (Chunky пише прогрес щосекунди).
 */

/** Скільки останніх рядків тягнути при підключенні (щоб одразу побачити прогрес). */
const ATTACH_TAIL_LINES = 150;

interface PregenMonitorDeps {
  containers: ContainerManager;
  /** Викликається, коли прогрес сервера змінився (для WS-пушу в консоль). */
  onUpdate: (serverId: string, progress: PregenProgress | null) => void;
  log: { info(m: string): void; warn(m: string): void };
}

interface Session {
  containerId: string;
  stop: () => void;
}

export class PregenMonitor {
  private readonly deps: PregenMonitorDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly progress = new Map<string, PregenProgress>();

  constructor(deps: PregenMonitorDeps) {
    this.deps = deps;
  }

  /** Поточний прогрес сервера (для ServerView). */
  getProgress(serverId: string): PregenProgress | null {
    return this.progress.get(serverId) ?? null;
  }

  /**
   * Ідемпотентно вмикає моніторинг для сервера. Нічого не робить, якщо
   * прегенерація не налаштована, контейнера немає або моніторинг уже активний
   * (для того самого контейнера).
   */
  ensureMonitoring(record: ServerRecord): void {
    if (!record.pregenRadius || !record.containerId) return;
    const existing = this.sessions.get(record.id);
    if (existing?.containerId === record.containerId) return;
    if (existing) existing.stop(); // контейнер перестворили — перепідключаємось

    const serverId = record.id;
    const containerId = record.containerId;
    // Одразу «застовпимо» сесію-плейсхолдер, щоб паралельні виклики не відкрили два потоки.
    const placeholder: Session = { containerId, stop: () => {} };
    this.sessions.set(serverId, placeholder);

    void this.deps.containers
      .streamLogLines(containerId, ATTACH_TAIL_LINES, (line) => this.handleLine(serverId, line))
      .then((stop) => {
        // Сервер могли зупинити, поки відкривався потік.
        if (this.sessions.get(serverId) !== placeholder) {
          stop();
          return;
        }
        this.sessions.set(serverId, { containerId, stop });
        this.deps.log.info(`Монітор прегенерації підключено до сервера ${serverId}`);
      })
      .catch((err) => {
        if (this.sessions.get(serverId) === placeholder) this.sessions.delete(serverId);
        this.deps.log.warn(
          `Не вдалося підключити монітор прегенерації ${serverId}: ${err instanceof Error ? err.message : err}`,
        );
      });
  }

  /** Зупиняє моніторинг (сервер зупинено/видалено). Прогрес лишаємо для «finished». */
  stop(serverId: string, clearProgress = false): void {
    this.sessions.get(serverId)?.stop();
    this.sessions.delete(serverId);
    if (clearProgress) {
      this.progress.delete(serverId);
      this.deps.onUpdate(serverId, null);
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }

  private handleLine(serverId: string, line: string): void {
    const event = parseChunkyLine(line);
    if (!event) return;

    if (event.kind === 'finished') {
      const prev = this.progress.get(serverId);
      this.update(serverId, {
        state: 'finished',
        percent: 100,
        processedChunks: prev?.processedChunks ?? 0,
        etaSeconds: 0,
        rate: null,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (event.kind === 'stopped') {
      const prev = this.progress.get(serverId);
      // Якщо вже було 100% — не «псуємо» завершений стан наступним «stopped».
      if (prev?.state === 'finished') return;
      this.update(serverId, {
        state: 'cancelled',
        percent: prev?.percent ?? 0,
        processedChunks: prev?.processedChunks ?? 0,
        etaSeconds: null,
        rate: null,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    // progress
    this.update(serverId, {
      state: 'running',
      percent: event.percent,
      processedChunks: event.processedChunks,
      etaSeconds: event.etaSeconds,
      rate: event.rate,
      updatedAt: new Date().toISOString(),
    });
  }

  private update(serverId: string, progress: PregenProgress): void {
    this.progress.set(serverId, progress);
    this.deps.onUpdate(serverId, progress);
  }
}
