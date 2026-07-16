import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig } from '../config.js';
import type { ServerRepository } from '../db/serverRepository.js';
import { assertDockerAvailable, ensureImage, isDockerAvailable } from '../docker/client.js';
import type { ContainerManager } from '../docker/containerManager.js';
import type { ConsoleGateway } from '../docker/consoleGateway.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { resolveImageForVersion } from '../minecraft/images.js';
import {
  readServerProperties,
  updateServerProperties,
  type PropertiesFileState,
} from '../minecraft/properties.js';
import type { CreateServerInput, PropertyEntry, ServerRecord, ServerView } from '../types.js';
import { isPathInside } from '../utils/paths.js';
import { isTcpPortFree } from '../utils/ports.js';

/** Мінімальний інтерфейс логера (структурно сумісний із fastify.log / pino). */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface ServerServiceDeps {
  config: AppConfig;
  repo: ServerRepository;
  containers: ContainerManager;
  gateway: ConsoleGateway;
  log: Logger;
}

/** Скільки чекати на graceful stop у межах HTTP-запиту, перш ніж відповісти "зупиняється…". */
const STOP_WAIT_BUDGET_MS = 10_000;
const RESTART_WAIT_BUDGET_MS = 15_000;
/** Мінімальний інтервал між записами прогресу pull у БД, щоб не молотити диск. */
const PROGRESS_WRITE_INTERVAL_MS = 500;

export interface PropertiesResponse extends PropertiesFileState {
  /** Попередження для UI (наприклад, "зміни застосуються після рестарту"). */
  warning: string | null;
}

/**
 * Сервіс-оркестратор: єдине місце, де сходяться БД, Docker і WebSocket-шлюз.
 * REST-роути — тонкі обгортки над цими методами.
 */
export class ServerService {
  private readonly config: AppConfig;
  private readonly repo: ServerRepository;
  private readonly containers: ContainerManager;
  private readonly gateway: ConsoleGateway;
  private readonly log: Logger;

  constructor(deps: ServerServiceDeps) {
    this.config = deps.config;
    this.repo = deps.repo;
    this.containers = deps.containers;
    this.gateway = deps.gateway;
    this.log = deps.log;
  }

  // ---------------------------------------------------------------- читання

  async listServers(): Promise<ServerView[]> {
    const records = this.repo.list();
    const dockerUp = await isDockerAvailable();
    return Promise.all(records.map((record) => this.toView(record, dockerUp)));
  }

  async getServer(id: string): Promise<ServerView> {
    const record = this.mustGet(id);
    return this.toView(record, await isDockerAvailable());
  }

  /** Доступ для WS-роута консолі: живий запис із БД без обчислення runtime. */
  getRecord(id: string): ServerRecord | null {
    return this.repo.get(id);
  }

  /** Обчислює зведений runtime-стан для UI (див. RuntimeStatus у types.ts). */
  private async toView(record: ServerRecord, dockerUp: boolean): Promise<ServerView> {
    if (record.status === 'provisioning') {
      return { ...record, runtime: 'creating', runtimeDetail: record.statusDetail };
    }
    if (record.status === 'error') {
      return { ...record, runtime: 'error', runtimeDetail: record.statusDetail };
    }
    if (!dockerUp) {
      return { ...record, runtime: 'unknown', runtimeDetail: 'Docker-демон недоступний' };
    }
    if (!record.containerId) {
      return { ...record, runtime: 'stopped', runtimeDetail: 'Контейнер буде створено при запуску' };
    }

    const state = await this.containers.inspectState(record.containerId).catch(() => null);
    if (!state?.exists) {
      return {
        ...record,
        runtime: 'stopped',
        runtimeDetail: 'Контейнер відсутній — буде створений повторно при запуску',
      };
    }
    if (state.running) {
      return { ...record, runtime: 'running', runtimeDetail: null };
    }
    const detail =
      state.exitCode !== null && state.exitCode !== 0
        ? `Процес завершився з кодом ${state.exitCode}`
        : null;
    return { ...record, runtime: 'stopped', runtimeDetail: detail };
  }

  private mustGet(id: string): ServerRecord {
    const record = this.repo.get(id);
    if (!record) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    return record;
  }

  // --------------------------------------------------------------- створення

  /**
   * Створює сервер: валідує унікальність, готує директорію даних, пише запис у БД
   * і у ФОНІ виконує провізію (pull образу + створення контейнера). Відповідь
   * повертається одразу — фронтенд бачить стан "creating" і полить список.
   */
  async createServer(input: CreateServerInput): Promise<ServerView> {
    if (this.repo.findByName(input.name)) {
      throw new ConflictError(`Сервер з іменем «${input.name}» уже існує`);
    }
    if (this.repo.findByPort(input.hostPort)) {
      throw new ConflictError(`Порт ${input.hostPort} уже закріплено за іншим сервером`);
    }
    if (input.hostPort === this.config.port) {
      throw new ConflictError(`Порт ${input.hostPort} зайнятий самою панеллю`);
    }
    if (!(await isTcpPortFree(input.hostPort, this.config.gameBindHost))) {
      throw new ConflictError(`Порт ${input.hostPort} уже зайнятий іншим процесом на цьому комп'ютері`);
    }

    // Ранній чіткий 503, поки користувач ще у формі створення.
    await assertDockerAvailable();

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ServerRecord = {
      id,
      name: input.name,
      kind: input.kind,
      version: input.version,
      hostPort: input.hostPort,
      memoryMb: input.memoryMb,
      dataDir: path.join(this.config.serversRoot, id),
      containerId: null,
      status: 'provisioning',
      statusDetail: 'У черзі на створення…',
      createdAt: now,
      updatedAt: now,
    };

    fs.mkdirSync(record.dataDir, { recursive: true });
    this.repo.insert(record);

    // Свідомо не чекаємо: pull образу може тривати хвилини.
    void this.provision(id, input.autoStart);

    return this.toView(record, true);
  }

  /**
   * Фонова провізія: образ → контейнер → (опційно) старт.
   * Будь-яка помилка фіксується у статусі запису і показується у UI.
   */
  private async provision(id: string, autoStart: boolean): Promise<void> {
    try {
      const record = this.repo.get(id);
      if (!record) return; // сервер устигли видалити

      const docker = await assertDockerAvailable();
      const image = resolveImageForVersion(record.version);

      let lastProgressWrite = 0;
      await ensureImage(docker, image, (line) => {
        const now = Date.now();
        if (now - lastProgressWrite >= PROGRESS_WRITE_INTERVAL_MS) {
          lastProgressWrite = now;
          this.repo.update(id, { statusDetail: line });
        }
      });

      // Поки тягнувся образ, сервер могли видалити — не створюємо контейнер-сироту.
      if (!this.repo.get(id)) return;

      this.repo.update(id, { statusDetail: 'Створення контейнера…' });
      const containerId = await this.containers.createServerContainer(record, this.config.gameBindHost);

      if (!this.repo.get(id)) {
        // Запис зник під час створення контейнера — прибираємо за собою.
        await this.containers.removeIfExists(containerId);
        return;
      }
      const ready = this.repo.update(id, {
        containerId,
        status: 'ready',
        statusDetail: null,
      });
      this.log.info(`Сервер ${record.name} (${id}) створено, контейнер ${containerId.slice(0, 12)}`);

      if (autoStart && ready) {
        await this.containers.start(containerId);
        await this.gateway.notifyRuntimeChange(ready, 'running');
        this.log.info(`Сервер ${record.name} (${id}) запущено`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Якщо запис ще існує — фіксуємо помилку, користувач побачить її в UI
      // і зможе повторити спробу кнопкою "Запустити".
      if (this.repo.get(id)) {
        this.repo.update(id, { status: 'error', statusDetail: message });
      }
      this.log.error(`Провізія сервера ${id} завершилася помилкою: ${message}`);
    }
  }

  // ---------------------------------------------------------- життєвий цикл

  async startServer(id: string): Promise<ServerView> {
    const record = this.mustGet(id);
    if (record.status === 'provisioning') {
      throw new ConflictError('Сервер ще створюється — зачекайте завершення');
    }
    await assertDockerAvailable();

    // Помилкова провізія або зниклий контейнер → повторюємо провізію з автозапуском.
    if (record.status === 'error' || !record.containerId) {
      return this.reprovision(id);
    }
    const state = await this.containers.inspectState(record.containerId);
    if (!state.exists) {
      return this.reprovision(id);
    }
    if (state.running) {
      return this.toView(record, true); // уже працює — ідемпотентність
    }

    await this.containers.start(record.containerId);
    await this.gateway.notifyRuntimeChange(record, 'running');
    return this.toView(record, true);
  }

  private async reprovision(id: string): Promise<ServerView> {
    const fresh = this.repo.update(id, {
      status: 'provisioning',
      statusDetail: 'Повторне створення контейнера…',
    });
    if (!fresh) throw new NotFoundError(`Сервер з id=${id} не знайдено`);
    void this.provision(id, true);
    return this.toView(fresh, true);
  }

  async stopServer(id: string): Promise<ServerView> {
    const record = this.mustGet(id);
    if (record.status === 'provisioning') {
      throw new ConflictError('Сервер ще створюється — його не можна зупинити');
    }
    await assertDockerAvailable();
    if (!record.containerId) {
      return this.toView(record, true);
    }

    const state = await this.containers.inspectState(record.containerId);
    if (!state.exists || !state.running) {
      return this.toView(record, true); // уже зупинено
    }

    // Graceful stop може тривати до 60 с (збереження світу). Чекаємо максимум
    // STOP_WAIT_BUDGET_MS у межах запиту, далі зупинка триває у фоні, а UI
    // бачить актуальний стан через полінг.
    const stopPromise = this.containers
      .stop(record.containerId)
      .then(() => this.gateway.notifyRuntimeChange(record, 'stopped'))
      .catch((err) =>
        this.log.warn(`Зупинка сервера ${id}: ${err instanceof Error ? err.message : err}`),
      );
    await Promise.race([stopPromise, sleep(STOP_WAIT_BUDGET_MS)]);

    return this.toView(record, true);
  }

  async restartServer(id: string): Promise<ServerView> {
    const record = this.mustGet(id);
    if (record.status === 'provisioning') {
      throw new ConflictError('Сервер ще створюється — його не можна перезапустити');
    }
    await assertDockerAvailable();
    if (record.status === 'error' || !record.containerId) {
      return this.reprovision(id);
    }
    const state = await this.containers.inspectState(record.containerId);
    if (!state.exists) {
      return this.reprovision(id);
    }

    const restartPromise = this.containers
      .restart(record.containerId)
      .then(() => this.gateway.notifyRuntimeChange(record, 'running'))
      .catch((err) =>
        this.log.warn(`Перезапуск сервера ${id}: ${err instanceof Error ? err.message : err}`),
      );
    await Promise.race([restartPromise, sleep(RESTART_WAIT_BUDGET_MS)]);

    return this.toView(record, true);
  }

  /**
   * Видаляє сервер: контейнер (примусово), запис у БД і, за бажанням, файли світу.
   */
  async deleteServer(id: string, deleteData: boolean): Promise<void> {
    const record = this.mustGet(id);

    // Якщо контейнер існує, для видалення потрібен живий Docker — інакше
    // залишиться контейнер-сирота, про який панель забуде.
    if (record.containerId) {
      await assertDockerAvailable();
      await this.containers.removeIfExists(record.containerId);
    }

    this.gateway.closeServer(id, 'Сервер видалено.');
    this.repo.delete(id);

    if (deleteData) {
      // Подвійний захист від rm -rf поза директорією серверів панелі.
      if (isPathInside(this.config.serversRoot, record.dataDir)) {
        await fs.promises.rm(record.dataDir, { recursive: true, force: true });
      } else {
        this.log.warn(
          `Відмовляюся видаляти дані сервера ${id}: шлях ${record.dataDir} поза ${this.config.serversRoot}`,
        );
      }
    }
    this.log.info(`Сервер ${record.name} (${id}) видалено${deleteData ? ' разом із даними' : ''}`);
  }

  // ------------------------------------------------------- server.properties

  async getProperties(id: string): Promise<PropertiesResponse> {
    const record = this.mustGet(id);
    const state = readServerProperties(record.dataDir);
    return { ...state, warning: await this.propertiesWarning(record) };
  }

  async updateProperties(id: string, entries: PropertyEntry[]): Promise<PropertiesResponse> {
    const record = this.mustGet(id);
    const state = updateServerProperties(record.dataDir, entries);
    this.log.info(`Оновлено server.properties сервера ${record.name} (${entries.length} ключ(ів))`);
    return { ...state, warning: await this.propertiesWarning(record) };
  }

  private async propertiesWarning(record: ServerRecord): Promise<string | null> {
    if (!record.containerId || !(await isDockerAvailable())) return null;
    const state = await this.containers.inspectState(record.containerId).catch(() => null);
    return state?.running
      ? 'Сервер зараз запущено: зміни застосуються після перезапуску.'
      : null;
  }
}
