import { PassThrough, Writable } from 'node:stream';
import type Docker from 'dockerode';
import { isDockerNotFound, translateDockerError } from '../errors.js';
import {
  buildContainerEnv,
  containerMemoryBytes,
  containerNameFor,
  MANAGED_LABEL,
  MINECRAFT_CONTAINER_PORT,
  resolveImageForVersion,
  SERVER_ID_LABEL,
} from '../minecraft/images.js';
import type { ServerRecord } from '../types.js';
import { toDockerBindPath } from '../utils/paths.js';

/** Скільки секунд Docker чекає на graceful stop, перш ніж послати SIGKILL. */
const STOP_TIMEOUT_SECONDS = 60;

/** Живий стан контейнера, зведений до потрібного нам мінімуму. */
export interface ContainerRuntimeInfo {
  exists: boolean;
  running: boolean;
  /** Сирий статус Docker: created / running / paused / restarting / exited / dead. */
  state: string | null;
  exitCode: number | null;
  startedAt: string | null;
}

/**
 * Обгортка над dockerode для операцій із Minecraft-контейнерами.
 * Кожен метод перекладає помилки Docker на AppError із зрозумілим текстом.
 */
export class ContainerManager {
  constructor(private readonly docker: Docker) {}

  /**
   * Створює (але не запускає) контейнер для сервера.
   * Повертає ID нового контейнера.
   */
  async createServerContainer(record: ServerRecord, gameBindHost: string): Promise<string> {
    const image = resolveImageForVersion(record.version);
    const name = containerNameFor(record.id);
    const portKey = `${MINECRAFT_CONTAINER_PORT}/tcp`;

    const createOptions: Docker.ContainerCreateOptions = {
      name,
      Image: image,
      // Tty=false → потоки stdout/stderr мультиплексуються (розбираємо demuxStream),
      // OpenStdin=true → можна приєднатися і писати команди у консоль сервера.
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      Env: buildContainerEnv(record),
      Labels: {
        [MANAGED_LABEL]: 'true',
        [SERVER_ID_LABEL]: record.id,
      },
      ExposedPorts: { [portKey]: {} },
      // Даємо серверу час зберегти світ при зупинці (itzg перехоплює SIGTERM → "stop").
      StopTimeout: STOP_TIMEOUT_SECONDS,
      HostConfig: {
        // Bind-mount: файли сервера лежать на хості та доступні користувачу напряму.
        // Суфікс :Z — SELinux-мітка (Fedora/RHEL): без неї контейнеру заборонено
        // писати у примонтовану теку (Permission denied на eula.txt). На системах
        // без SELinux (Ubuntu, Docker Desktop) прапорець просто ігнорується.
        Binds: [`${toDockerBindPath(record.dataDir)}:/data:Z`],
        PortBindings: {
          [portKey]: [{ HostIp: gameBindHost, HostPort: String(record.hostPort) }],
        },
        Memory: containerMemoryBytes(record.memoryMb),
        // MemorySwap == Memory → своп для контейнера вимкнено.
        MemorySwap: containerMemoryBytes(record.memoryMb),
        // Ліміт CPU у ядрах (1 ядро = 1e9 наносекунд CPU за секунду).
        ...(record.cpuCores ? { NanoCpus: Math.round(record.cpuCores * 1e9) } : {}),
        // Після перезавантаження хоста запущені сервери піднімуться самі,
        // але явна зупинка з панелі (docker stop) залишиться зупинкою.
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };

    try {
      const container = await this.docker.createContainer(createOptions);
      return container.id;
    } catch (err) {
      // 409 — залишився контейнер з таким ім'ям (наприклад, після збою панелі):
      // прибираємо сироту і пробуємо ще раз.
      if ((err as { statusCode?: number })?.statusCode === 409) {
        await this.removeByName(name);
        const container = await this.docker.createContainer(createOptions).catch((retryErr) => {
          throw translateDockerError(retryErr, 'Створення контейнера');
        });
        return container.id;
      }
      throw translateDockerError(err, 'Створення контейнера');
    }
  }

  /**
   * Binds контейнера (для перевірки, чи створений він ще старою версією панелі
   * без SELinux-мітки :Z). null — контейнер не існує.
   */
  async getBinds(containerId: string): Promise<string[] | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return info.HostConfig?.Binds ?? [];
    } catch (err) {
      if (isDockerNotFound(err)) return null;
      throw translateDockerError(err, 'Перевірка налаштувань контейнера');
    }
  }

  /** Живий стан контейнера; для видаленого вручну контейнера повертає exists=false. */
  async inspectState(containerId: string): Promise<ContainerRuntimeInfo> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return {
        exists: true,
        running: info.State.Running,
        state: info.State.Status ?? null,
        exitCode: typeof info.State.ExitCode === 'number' ? info.State.ExitCode : null,
        startedAt: info.State.StartedAt ?? null,
      };
    } catch (err) {
      if (isDockerNotFound(err)) {
        return { exists: false, running: false, state: null, exitCode: null, startedAt: null };
      }
      throw translateDockerError(err, 'Отримання стану контейнера');
    }
  }

  async start(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).start();
    } catch (err) {
      // 304 Not Modified — контейнер уже запущений; для нас це успіх.
      if ((err as { statusCode?: number })?.statusCode === 304) return;
      throw translateDockerError(err, 'Запуск сервера');
    }
  }

  async stop(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t: STOP_TIMEOUT_SECONDS });
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 304) return; // уже зупинений
      if (isDockerNotFound(err)) return; // контейнера немає — вважаємо зупиненим
      throw translateDockerError(err, 'Зупинка сервера');
    }
  }

  async restart(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).restart({ t: STOP_TIMEOUT_SECONDS });
    } catch (err) {
      throw translateDockerError(err, 'Перезапуск сервера');
    }
  }

  /** Видаляє контейнер (force — уб'є, якщо ще працює). Відсутній контейнер — не помилка. */
  async removeIfExists(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true });
    } catch (err) {
      if (isDockerNotFound(err)) return;
      throw translateDockerError(err, 'Видалення контейнера');
    }
  }

  /**
   * Підписка на логи контейнера ПОРЯДКОВО (для фонового парсингу прогресу
   * Chunky, незалежно від того, чи відкрита консоль). Повертає функцію зупинки.
   * `tail` — скільки останніх рядків отримати одразу (для швидкого відновлення
   * стану після рестарту панелі).
   */
  async streamLogLines(
    containerId: string,
    tail: number,
    onLine: (line: string) => void,
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerId);
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.logs({ follow: true, stdout: true, stderr: true, tail });
    } catch (err) {
      throw translateDockerError(err, 'Підписка на логи контейнера');
    }

    let buffer = '';
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line) onLine(line);
          nl = buffer.indexOf('\n');
        }
        cb();
      },
    });
    // Tty=false → потік мультиплексований; demux розкладає stdout/stderr.
    this.docker.modem.demuxStream(stream, sink, sink);

    return () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
  }

  /**
   * Виконує команду всередині запущеного контейнера і повертає її вивід.
   * Використовується для RCON без відкриття портів: `docker exec <c> rcon-cli …`
   * (rcon-cli вбудований в образ itzg і сам знає пароль з env контейнера).
   */
  async execCapture(
    containerId: string,
    cmd: string[],
    timeoutMs = 10_000,
  ): Promise<{ exitCode: number | null; output: string }> {
    try {
      const container = this.docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});

      const chunks: Buffer[] = [];
      const sink = new PassThrough();
      sink.on('data', (chunk: Buffer) => chunks.push(chunk));
      // exec-потік мультиплексований так само, як логи контейнера.
      this.docker.modem.demuxStream(stream, sink, sink);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          reject(new Error(`Команда ${cmd[0]} не завершилася за ${timeoutMs} мс`));
        }, timeoutMs);
        stream.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        stream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const inspect = await exec.inspect();
      return {
        exitCode: typeof inspect.ExitCode === 'number' ? inspect.ExitCode : null,
        output: Buffer.concat(chunks).toString('utf8').trim(),
      };
    } catch (err) {
      throw translateDockerError(err, `Виконання ${cmd[0]} у контейнері`);
    }
  }

  private async removeByName(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (err) {
      if (!isDockerNotFound(err)) {
        throw translateDockerError(err, 'Видалення застарілого контейнера');
      }
    }
  }
}
