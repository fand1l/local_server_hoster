import Docker from 'dockerode';
import { DockerUnavailableError, translateDockerError } from '../errors.js';

/**
 * Єдиний екземпляр клієнта Docker на весь процес.
 *
 * dockerode (через docker-modem) сам обирає спосіб підключення:
 *  - Linux/macOS: unix-сокет /var/run/docker.sock;
 *  - Windows:     named pipe //./pipe/docker_engine;
 *  - або значення змінних середовища DOCKER_HOST / DOCKER_TLS_VERIFY / DOCKER_CERT_PATH.
 * Тобто кросплатформність підключення отримуємо "з коробки".
 */
let docker: Docker | null = null;

export function getDocker(): Docker {
  if (!docker) {
    docker = new Docker();
  }
  return docker;
}

/** М'яка перевірка доступності демона: true/false без винятків. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}

/** Жорстка перевірка: повертає клієнт або кидає DockerUnavailableError (HTTP 503). */
export async function assertDockerAvailable(): Promise<Docker> {
  const client = getDocker();
  try {
    await client.ping();
    return client;
  } catch (err) {
    throw new DockerUnavailableError((err as { code?: string })?.code);
  }
}

/** Подія прогресу з Docker pull (підмножина полів, які нам потрібні). */
interface PullProgressEvent {
  status?: string;
  id?: string;
  progress?: string;
}

/**
 * Гарантує наявність образу локально: якщо його немає — тягне з реєстру.
 * `onProgress` викликається з людиночитним рядком стану (для statusDetail у БД).
 */
export async function ensureImage(
  client: Docker,
  imageRef: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  try {
    await client.getImage(imageRef).inspect();
    return; // Образ уже є — нічого робити не треба.
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      throw translateDockerError(err, `Перевірка образу ${imageRef}`);
    }
  }

  onProgress?.(`Завантаження образу ${imageRef}…`);
  let stream: NodeJS.ReadableStream;
  try {
    stream = await client.pull(imageRef);
  } catch (err) {
    throw translateDockerError(err, `Завантаження образу ${imageRef}`);
  }

  // followProgress парсить JSON-потік прогресу і викликає onFinished наприкінці.
  await new Promise<void>((resolve, reject) => {
    client.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: PullProgressEvent) => {
        if (!onProgress) return;
        // Показуємо лише "великі" фази, щоб не спамити оновленнями БД на кожен шар.
        if (event.status && /Downloading|Extracting|Pull complete|Downloaded/i.test(event.status)) {
          const layer = event.id ? ` (шар ${event.id})` : '';
          onProgress(`Завантаження образу ${imageRef}: ${event.status}${layer}`);
        }
      },
    );
  }).catch((err) => {
    throw translateDockerError(err, `Завантаження образу ${imageRef}`);
  });
}
