import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type Docker from 'dockerode';
import type { WebSocket } from 'ws';
import { BadRequestError, ConflictError, isDockerNotFound } from '../errors.js';
import type { ConsoleServerMessage, RuntimeStatus, ServerRecord } from '../types.js';

/** Скільки останніх рядків логу віддавати новому глядачу консолі. */
const LOG_TAIL_LINES = 200;
/** Максимальна довжина однієї команди у консоль. */
const MAX_COMMAND_LENGTH = 512;

/** ANSI escape-послідовності (кольори тощо) — вирізаємо, консоль у нас текстова. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

function sanitizeLogChunk(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Сесія консолі одного сервера: один спільний потік логів Docker
 * і один спільний stdin-attach на будь-яку кількість підключених браузерів.
 */
class ConsoleSession {
  readonly clients = new Set<WebSocket>();

  /**
   * Лічильник "поколінь" потоку логів. Кожен (ре)старт стріму збільшує його,
   * а колбеки старого стріму звіряються з ним і мовчки вмирають — це прибирає
   * гонки при швидких stop/start/restart.
   */
  private logGeneration = 0;
  private logStream: NodeJS.ReadableStream | null = null;
  private stdinStream: NodeJS.ReadWriteStream | null = null;

  constructor(
    private readonly docker: Docker,
    readonly serverId: string,
  ) {}

  broadcast(message: ConsoleServerMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  /**
   * Запускає (або перезапускає) трансляцію логів контейнера всім клієнтам сесії.
   * Аналог `docker logs --follow --tail 200`.
   */
  async startLogStream(containerId: string): Promise<void> {
    const generation = ++this.logGeneration;
    this.destroyLogStream();

    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.getContainer(containerId).logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: LOG_TAIL_LINES,
      });
    } catch (err) {
      if (generation !== this.logGeneration) return; // уже неактуально
      if (isDockerNotFound(err)) {
        this.broadcast({ type: 'info', message: 'Контейнер ще не створено — логів немає.' });
      } else {
        this.broadcast({ type: 'error', message: 'Не вдалося підключитися до логів контейнера.' });
      }
      return;
    }

    if (generation !== this.logGeneration) {
      // Поки чекали на відповідь Docker, хтось уже перезапустив стрім.
      (stream as unknown as { destroy?: () => void }).destroy?.();
      return;
    }
    this.logStream = stream;

    // Tty=false → Docker мультиплексує stdout/stderr в один потік з 8-байтними
    // заголовками кадрів; demuxStream розкладає його назад на два потоки.
    this.docker.modem.demuxStream(stream, this.makeLogSink(), this.makeLogSink());

    const onStreamGone = (reason: string) => {
      if (generation !== this.logGeneration) return;
      this.logStream = null;
      this.broadcast({ type: 'info', message: reason });
    };
    stream.on('end', () => onStreamGone('Потік логів завершено (контейнер зупинено).'));
    stream.on('error', () => onStreamGone('Потік логів обірвався.'));
  }

  /** Writable-приймач для demuxStream: декодує UTF-8 частинами і розсилає клієнтам. */
  private makeLogSink(): Writable {
    // Окремий StringDecoder на потік: коректно склеює багатобайтові символи,
    // розрізані межами TCP-чанків (кирилиця в логах — звична справа).
    const decoder = new StringDecoder('utf8');
    const session = this;
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const text = sanitizeLogChunk(decoder.write(chunk));
        if (text.length > 0) {
          session.broadcast({ type: 'log', data: text });
        }
        callback();
      },
    });
  }

  /**
   * Надсилає команду у консоль сервера — пише у stdin процесу контейнера
   * через attach із hijack (те, що робить `docker attach`).
   */
  async sendCommand(containerId: string, rawCommand: string): Promise<void> {
    const command = rawCommand.replace(/[\r\n]+/g, ' ').trim();
    if (!command) {
      throw new BadRequestError('Команда порожня');
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new BadRequestError(`Команда задовга (максимум ${MAX_COMMAND_LENGTH} символів)`);
    }

    const stdin = await this.ensureStdinAttached(containerId);
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${command}\n`, (err) => (err ? reject(err) : resolve()));
    }).catch(() => {
      // Запис не вдався (контейнер щойно зупинився?) — скидаємо attach,
      // наступна команда спробує приєднатися заново.
      this.destroyStdinStream();
      throw new ConflictError('Не вдалося надіслати команду: сервер не приймає ввід.');
    });

    // Показуємо всім глядачам, що саме було надіслано з панелі.
    this.broadcast({ type: 'log', data: `> ${command}\n` });
  }

  /** Лінива установка attach-з'єднання зі stdin контейнера (одне на сесію). */
  private async ensureStdinAttached(containerId: string): Promise<NodeJS.ReadWriteStream> {
    if (this.stdinStream) return this.stdinStream;

    const container = this.docker.getContainer(containerId);
    const state = await container.inspect().catch((err) => {
      if (isDockerNotFound(err)) return null;
      throw err;
    });
    if (!state?.State.Running) {
      throw new ConflictError('Сервер не запущено — команду нікому виконувати.');
    }

    // stdout/stderr тут не потрібні: логи вже транслюються через startLogStream.
    const stream = (await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    })) as NodeJS.ReadWriteStream;

    const reset = () => {
      if (this.stdinStream === stream) this.stdinStream = null;
    };
    stream.on('error', reset);
    stream.on('close', reset);
    stream.on('end', reset);

    this.stdinStream = stream;
    return stream;
  }

  destroyLogStream(): void {
    if (this.logStream) {
      (this.logStream as unknown as { destroy?: () => void }).destroy?.();
      this.logStream = null;
    }
  }

  private destroyStdinStream(): void {
    if (this.stdinStream) {
      (this.stdinStream as unknown as { destroy?: () => void }).destroy?.();
      this.stdinStream = null;
    }
  }

  /** Повне прибирання сесії (потоки + сокети). */
  destroy(closeMessage?: string): void {
    this.logGeneration += 1; // інвалідовуємо всі колбеки
    this.destroyLogStream();
    this.destroyStdinStream();
    for (const socket of this.clients) {
      if (closeMessage && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'info', message: closeMessage } satisfies ConsoleServerMessage));
      }
      socket.close();
    }
    this.clients.clear();
  }
}

/**
 * Шлюз консолей: тримає по одній ConsoleSession на сервер,
 * створює/прибирає їх у міру підключення браузерів
 * і реагує на зміни життєвого циклу серверів (start/stop/delete).
 */
export class ConsoleGateway {
  private readonly sessions = new Map<string, ConsoleSession>();

  constructor(private readonly getDockerClient: () => Docker) {}

  /** Підключає WebSocket-клієнта до консолі сервера. */
  async subscribe(record: ServerRecord, socket: WebSocket): Promise<void> {
    let session = this.sessions.get(record.id);
    if (!session) {
      session = new ConsoleSession(this.getDockerClient(), record.id);
      this.sessions.set(record.id, session);
    }

    const isFirstClient = session.clients.size === 0;
    session.clients.add(socket);

    socket.send(
      JSON.stringify({
        type: 'info',
        message: `Підключено до консолі «${record.name}».`,
      } satisfies ConsoleServerMessage),
    );

    // Потік логів спільний: піднімаємо його лише для першого глядача.
    if (isFirstClient && record.containerId) {
      await session.startLogStream(record.containerId);
    }
  }

  /** Від'єднує клієнта; коли глядачів не лишилося — звільняє ресурси Docker. */
  unsubscribe(serverId: string, socket: WebSocket): void {
    const session = this.sessions.get(serverId);
    if (!session) return;
    session.clients.delete(socket);
    if (session.clients.size === 0) {
      session.destroy();
      this.sessions.delete(serverId);
    }
  }

  /** Надсилає команду в консоль сервера (викликається з WS-роута). */
  async sendCommand(record: ServerRecord, command: string): Promise<void> {
    if (!record.containerId) {
      throw new ConflictError('Сервер ще не створено — консоль недоступна.');
    }
    let session = this.sessions.get(record.id);
    if (!session) {
      // Теоретично можливо лише при гонці підключення/відключення.
      session = new ConsoleSession(this.getDockerClient(), record.id);
      this.sessions.set(record.id, session);
    }
    await session.sendCommand(record.containerId, command);
  }

  /**
   * Гачок життєвого циклу: сервіс повідомляє про start/stop/restart,
   * щоб відкриті консолі перепідключили потік логів і оновили статус.
   */
  async notifyRuntimeChange(record: ServerRecord, runtime: RuntimeStatus): Promise<void> {
    const session = this.sessions.get(record.id);
    if (!session) return;
    session.broadcast({ type: 'status', runtime });
    if (runtime === 'running' && record.containerId && session.clients.size > 0) {
      await session.startLogStream(record.containerId).catch(() => {
        session.broadcast({ type: 'error', message: 'Не вдалося перепідключити потік логів.' });
      });
    }
  }

  /** Показує інформаційне повідомлення панелі у відкритих консолях сервера (якщо є). */
  notifyInfo(serverId: string, message: string): void {
    this.sessions.get(serverId)?.broadcast({ type: 'info', message });
  }

  /** Викликається при видаленні сервера: закриває консолі всіх глядачів. */
  closeServer(serverId: string, reason: string): void {
    const session = this.sessions.get(serverId);
    if (!session) return;
    session.destroy(reason);
    this.sessions.delete(serverId);
  }

  /** Акуратне завершення роботи процесу панелі. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.destroy('Панель зупиняється.');
    }
    this.sessions.clear();
  }
}
