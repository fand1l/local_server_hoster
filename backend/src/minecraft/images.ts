import os from 'node:os';
import type { ServerKind, ServerRecord } from '../types.js';

/**
 * Побудова конфігурації Minecraft-контейнера на базі образу itzg/minecraft-server.
 *
 * Чому itzg/minecraft-server, а не "чистий openjdk + свій jar":
 *  - образ сам завантажує потрібний jar (Vanilla з Mojang, Paper з paper.io API, Fabric-інсталер),
 *    тобто виконує вимогу "бекенд сам стягує потрібний jar";
 *  - усередині працює mc-server-runner: перехоплює SIGTERM від `docker stop`
 *    і коректно виконує `stop` у консолі сервера (світ зберігається);
 *  - stdin контейнера прокидається у stdin java-процесу — саме це дозволяє
 *    надсилати команди через docker attach.
 *
 * Альтернатива на "чистому" JRE лежить у docker/custom-jre/Dockerfile (див. README).
 */

/** Порт Minecraft усередині контейнера (фіксований, назовні мапиться hostPort). */
export const MINECRAFT_CONTAINER_PORT = 25565;

const IMAGE_REPO = 'itzg/minecraft-server';

/** Docker-мітки, за якими можна знайти контейнери, створені цією панеллю. */
export const MANAGED_LABEL = 'mc-hoster.managed';
export const SERVER_ID_LABEL = 'mc-hoster.server-id';

/**
 * Підбирає тег образу з відповідною версією Java під версію Minecraft.
 *
 * Стара схема нумерації "1.MINOR.PATCH":
 *   до 1.16.x включно — Java 8;  1.17.x — Java 17 (мінімум 16);
 *   1.18–1.20.4 — Java 17;       1.20.5–1.21.x — Java 21.
 *
 * Нова схема Mojang (з кінця 2025 року, після 1.21.x — рік-орієнтована:
 * "26.1", "26.2", …) вимагає Java 21+, тож для неї беремо latest.
 * Так само latest для нечислових версій (LATEST, снапшоти) — цей тег itzg
 * завжди несе найновішу підтримувану Java.
 */
export function resolveImageForVersion(version: string): string {
  const trimmed = version.trim();
  const legacy = /^1\.(\d+)(?:\.(\d+))?$/.exec(trimmed);

  // Нова схема ("26.2", "26.1.1") або будь-що нечислове → latest (новітня Java).
  if (!legacy) return `${IMAGE_REPO}:latest`;

  const minor = Number(legacy[1]);
  const patch = Number(legacy[2] ?? '0');

  let tag: string;
  if (minor <= 16) tag = 'java8-multiarch';
  else if (minor <= 19) tag = 'java17';
  else if (minor === 20) tag = patch >= 5 ? 'java21' : 'java17';
  else tag = 'java21'; // 1.21.x

  return `${IMAGE_REPO}:${tag}`;
}

/** Ім'я контейнера для сервера (унікальне, зручно шукати через docker ps). */
export function containerNameFor(serverId: string): string {
  return `mc-hoster-${serverId}`;
}

/**
 * Змінні середовища для контейнера itzg/minecraft-server.
 * Довідник: https://docker-minecraft-server.readthedocs.io/
 */
export function buildContainerEnv(
  record: Pick<
    ServerRecord,
    'kind' | 'version' | 'coreVersion' | 'memoryMb' | 'onlineMode' | 'pregenRadius'
  >,
): string[] {
  const env = [
    // EULA приймає користувач у формі створення; без цього образ навмисно не стартує.
    'EULA=TRUE',
    `TYPE=${record.kind satisfies ServerKind}`,
    `VERSION=${record.version}`,
    // MEMORY задає і -Xms, і -Xmx JVM.
    `MEMORY=${record.memoryMb}M`,
    // Явно вимикаємо GUI сервера (headless-контейнер).
    'GUI=FALSE',
    // Ліцензійна перевірка акаунтів (online-mode у server.properties).
    `ONLINE_MODE=${record.onlineMode ? 'TRUE' : 'FALSE'}`,
  ];

  // Автопрегенерація: образ itzg сам завантажить сумісну збірку Chunky
  // (плагін або мод — залежно від TYPE) з Modrinth при старті.
  if (record.pregenRadius) {
    env.push('MODRINTH_PROJECTS=chunky');
  }

  // Закріплена версія ядра (без неї образ бере останню доступну).
  if (record.coreVersion) {
    switch (record.kind) {
      case 'PAPER':
        env.push(`PAPER_BUILD=${record.coreVersion}`);
        break;
      case 'FABRIC':
        env.push(`FABRIC_LOADER_VERSION=${record.coreVersion}`);
        break;
      case 'FORGE':
        env.push(`FORGE_VERSION=${record.coreVersion}`);
        break;
      case 'NEOFORGE':
        env.push(`NEOFORGE_VERSION=${record.coreVersion}`);
        break;
      default:
        break; // VANILLA / SPIGOT окремої версії ядра не мають
    }
  }

  // На Linux itzg за замовчуванням працює від UID 1000 — щоб файли у bind-mount
  // належали поточному користувачу хоста, передаємо його UID/GID.
  if (process.platform === 'linux') {
    const { uid, gid } = os.userInfo();
    if (uid >= 0 && gid >= 0) {
      env.push(`UID=${uid}`, `GID=${gid}`);
    }
  }

  return env;
}

/**
 * Ліміт пам'яті контейнера: heap JVM + запас на metaspace/нативну пам'ять,
 * інакше OOM-killer уб'є сервер раніше, ніж JVM встигне скаржитися.
 */
export function containerMemoryBytes(memoryMb: number): number {
  const overheadMb = Math.max(512, Math.round(memoryMb * 0.25));
  return (memoryMb + overheadMb) * 1024 * 1024;
}
