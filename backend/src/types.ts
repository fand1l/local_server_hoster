/**
 * Спільні типи домену "Minecraft-сервер" для всього бекенду.
 *
 * УВАГА: фронтенд має дзеркальну копію DTO-типів у `frontend/src/types.ts`.
 * Якщо змінюєте щось тут — синхронізуйте і там.
 */

/** Тип ядра сервера. Значення збігаються зі змінною TYPE образу itzg/minecraft-server. */
export const SERVER_KINDS = ['PAPER', 'VANILLA', 'FABRIC', 'SPIGOT', 'FORGE', 'NEOFORGE'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

/**
 * Стан життєвого циклу запису про сервер у БД (стан "провізії"):
 *  - provisioning — тягнемо образ / створюємо контейнер;
 *  - ready        — контейнер створено, можна запускати/зупиняти;
 *  - error        — остання провізія завершилася помилкою (можна повторити через start).
 */
export type ProvisionStatus = 'provisioning' | 'ready' | 'error';

/**
 * Зведений стан для UI, обчислюється з ProvisionStatus + живого стану Docker:
 *  - creating — йде провізія;
 *  - running  — контейнер працює;
 *  - stopped  — контейнер існує (або буде перестворений), але не запущений;
 *  - error    — провізія впала;
 *  - unknown  — Docker-демон недоступний, живий стан невідомий.
 */
export type RuntimeStatus = 'creating' | 'running' | 'stopped' | 'error' | 'unknown';

/** Запис про сервер так, як він зберігається у SQLite. */
export interface ServerRecord {
  id: string;
  name: string;
  kind: ServerKind;
  /** Версія Minecraft ("26.2", "1.21.8", "LATEST" тощо) — передається в образ як VERSION. */
  version: string;
  /**
   * Версія ядра: для PAPER — номер білда (env PAPER_BUILD),
   * для FABRIC — версія лоадера (env FABRIC_LOADER_VERSION).
   * null — «остання доступна» (образ вирішує сам).
   */
  coreVersion: string | null;
  /** TCP-порт на хості, прокинутий на 25565 контейнера. */
  hostPort: number;
  /** Ліміт пам'яті JVM у мегабайтах (env MEMORY). */
  memoryMb: number;
  /** Ліміт CPU контейнера в ядрах (NanoCpus); null — без ліміту. */
  cpuCores: number | null;
  /** true — лише ліцензійні акаунти (online-mode); false — офлайн-режим. */
  onlineMode: boolean;
  /** Радіус автопрегенерації світу Chunky у блоках; null — вимкнено. */
  pregenRadius: number | null;
  /** true — команди прегенерації вже надіслано серверу. */
  pregenDone: boolean;
  /** Абсолютний шлях до директорії з файлами сервера на хості (bind-mount /data). */
  dataDir: string;
  /** ID Docker-контейнера, якщо він уже створений. */
  containerId: string | null;
  status: ProvisionStatus;
  /** Людиночитний деталізований стан ("Завантаження образу…", текст помилки тощо). */
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Живий прогрес прегенерації світу Chunky (у пам'яті, не в БД). */
export interface PregenProgress {
  /** running — генерується; finished — завершено; cancelled — зупинено. */
  state: 'running' | 'finished' | 'cancelled';
  /** 0..100 */
  percent: number;
  processedChunks: number;
  /** Оцінка часу до завершення в секундах (від Chunky). */
  etaSeconds: number | null;
  /** Швидкість, чанків/с. */
  rate: number | null;
  updatedAt: string;
}

/** DTO, який віддаємо фронтенду: запис БД + обчислений живий стан. */
export interface ServerView extends ServerRecord {
  runtime: RuntimeStatus;
  /** Додаткова інформація про живий стан (код виходу, "Docker недоступний" тощо). */
  runtimeDetail: string | null;
  /** Прогрес прегенерації Chunky, якщо вона зараз відома; інакше null. */
  pregenProgress: PregenProgress | null;
}

/** Поля сервера, які можна змінити після створення. */
export interface UpdateServerInput {
  name?: string;
  memoryMb?: number;
  /** null — зняти ліміт CPU. */
  cpuCores?: number | null;
  /** Порт гри на хості (зміна перестворює контейнер). */
  hostPort?: number;
}

/** Вхідні дані створення сервера (після zod-валідації). */
export interface CreateServerInput {
  name: string;
  kind: ServerKind;
  version: string;
  /** Версія ядра (білд Paper / лоадер Fabric); відсутнє = остання. */
  coreVersion?: string;
  hostPort: number;
  memoryMb: number;
  /** Ліміт CPU у ядрах; відсутнє = без ліміту. */
  cpuCores?: number;
  /** Ліцензійні акаунти (online-mode). Типово true. */
  onlineMode: boolean;
  /** Радіус автопрегенерації Chunky у блоках; відсутнє = вимкнено. */
  pregenRadius?: number;
  /** Користувач має явно прийняти Minecraft EULA — інакше сервер не стартує. */
  acceptEula: true;
  /** Одразу запустити сервер після створення контейнера. */
  autoStart: boolean;
}

/** Дії над гравцем, доступні з панелі. */
export const PLAYER_ACTIONS = [
  'kick',
  'ban',
  'pardon',
  'op',
  'deop',
  'whitelist-add',
  'whitelist-remove',
] as const;
export type PlayerAction = (typeof PLAYER_ACTIONS)[number];

/** Зведена інформація про відомого серверу гравця. */
export interface PlayerInfo {
  name: string;
  uuid: string | null;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}

/** Відповідь GET /api/servers/:id/players. */
export interface PlayersResponse {
  players: PlayerInfo[];
  onlineCount: number;
  /** Чи вдалося опитати сервер через RCON (точний онлайн). */
  rconAvailable: boolean;
  /** true — на сервері діє whitelist (з server.properties). */
  whitelistEnabled: boolean;
  warning: string | null;
}

/** Список версій із каталогу (онлайн-API або вбудований фолбек). */
export interface VersionListResult {
  versions: string[];
  /** 'online' — свіжі дані з API; 'fallback' — вбудований список (немає мережі). */
  source: 'online' | 'fallback';
}

/** Версії ядра під конкретну версію гри. */
export interface CoreVersionsResult extends VersionListResult {
  /** Рекомендоване значення (найновіший стабільний білд/лоадер) або null. */
  latest: string | null;
}

/** Один запис server.properties. */
export interface PropertyEntry {
  key: string;
  value: string;
}

/** Запис у файловому менеджері (файл або тека). */
export type FileEntryType = 'file' | 'directory';
export interface FileEntry {
  name: string;
  type: FileEntryType;
  sizeBytes: number;
  modifiedAt: string;
}

/** Вміст директорії (relative-шлях від кореня теки сервера; '' = корінь). */
export interface DirListing {
  path: string;
  entries: FileEntry[];
}

/** Текстовий вміст файлу для редактора. */
export interface FileTextContent {
  path: string;
  content: string;
}

/** Категорія доповнень сервера: плагіни (Paper/Spigot) чи моди (Fabric/Forge/NeoForge). */
export type AddonCategory = 'plugins' | 'mods';

/** Один встановлений .jar-плагін/мод. */
export interface AddonInfo {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Відповідь GET /api/servers/:id/addons. */
export interface AddonsResponse {
  /** false для Vanilla (немає завантажувача плагінів/модів). */
  supported: boolean;
  /** 'plugins' | 'mods' | null (Vanilla). */
  category: AddonCategory | null;
  addons: AddonInfo[];
  /** true — сервер запущено, зміни застосуються після рестарту. */
  requiresRestart: boolean;
  warning: string | null;
}

/** Один результат пошуку контенту на Modrinth. */
export interface AddonSearchHit {
  /** Ідентифікатор проєкту Modrinth (для встановлення). */
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  /** URL іконки проєкту або null. */
  iconUrl: string | null;
}

/** Відповідь GET /api/servers/:id/addons/search. */
export interface AddonSearchResponse {
  hits: AddonSearchHit[];
  total: number;
  offset: number;
  category: AddonCategory;
  /** 'online' — з Modrinth; 'offline' — немає з’єднання (hits порожній). */
  source: 'online' | 'offline';
}

/** Повідомлення WebSocket-консолі: сервер → клієнт. */
export type ConsoleServerMessage =
  | { type: 'log'; data: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'status'; runtime: RuntimeStatus }
  | { type: 'pregen'; progress: PregenProgress | null };

/** Повідомлення WebSocket-консолі: клієнт → сервер. */
export type ConsoleClientMessage = { type: 'command'; data: string };
