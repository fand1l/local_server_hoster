import fs from 'node:fs';
import path from 'node:path';
import type { ContainerManager } from '../docker/containerManager.js';
import type { ConsoleGateway } from '../docker/consoleGateway.js';
import { BadRequestError, ConflictError } from '../errors.js';
import { readServerProperties } from '../minecraft/properties.js';
import type { Logger } from './serverService.js';
import type { PlayerAction, PlayerInfo, PlayersResponse, ServerRecord } from '../types.js';

/** Нік Minecraft: 1–16 символів [A-Za-z0-9_]. */
export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;

/** Відповідь vanilla-сервера на `list`: "There are 2 of a max of 20 players online: A, B". */
const LIST_OUTPUT_PATTERN = /online:?\s*(.*)$/im;

/** Дія → команда консолі сервера. */
const ACTION_COMMANDS: Record<PlayerAction, (name: string) => string> = {
  kick: (name) => `kick ${name}`,
  ban: (name) => `ban ${name}`,
  pardon: (name) => `pardon ${name}`,
  op: (name) => `op ${name}`,
  deop: (name) => `deop ${name}`,
  'whitelist-add': (name) => `whitelist add ${name}`,
  'whitelist-remove': (name) => `whitelist remove ${name}`,
};

interface PlayerServiceDeps {
  containers: ContainerManager;
  gateway: ConsoleGateway;
  log: Logger;
}

/** Запис JSON-файлів сервера: usercache.json / whitelist.json / ops.json / banned-players.json. */
interface PlayerFileEntry {
  name?: string;
  uuid?: string;
}

/**
 * Керування гравцями.
 *
 * Джерела даних:
 *  - живий онлайн — RCON `list` через `docker exec rcon-cli` (порт не відкривається,
 *    пароль лишається всередині контейнера);
 *  - «відомі» гравці — usercache.json + whitelist/ops/banned-players.json
 *    зі змонтованої директорії сервера.
 * Дії виконуються тим самим RCON (з відповіддю сервера); якщо RCON вимкнено —
 * фолбек у stdin консолі без підтвердження.
 */
export class PlayerService {
  private readonly containers: ContainerManager;
  private readonly gateway: ConsoleGateway;
  private readonly log: Logger;

  constructor(deps: PlayerServiceDeps) {
    this.containers = deps.containers;
    this.gateway = deps.gateway;
    this.log = deps.log;
  }

  // ---------------------------------------------------------------- читання

  async listPlayers(record: ServerRecord): Promise<PlayersResponse> {
    const files = this.readPlayerFiles(record.dataDir);

    let online = new Set<string>();
    let rconAvailable = false;
    let warning: string | null = null;

    if (record.containerId) {
      const running = await this.isRunning(record.containerId);
      if (running) {
        try {
          online = await this.fetchOnline(record.containerId);
          rconAvailable = true;
        } catch {
          warning =
            'RCON недоступний (вимкнений у server.properties?) — точний список онлайну невідомий.';
        }
      }
    }

    // Зводимо всіх відомих гравців в один список (ключ — нік без регістру).
    const byName = new Map<string, PlayerInfo>();
    const upsert = (name: string, patch: Partial<PlayerInfo>) => {
      if (!PLAYER_NAME_PATTERN.test(name)) return;
      const key = name.toLowerCase();
      const existing = byName.get(key) ?? {
        name,
        uuid: null,
        online: false,
        op: false,
        whitelisted: false,
        banned: false,
      };
      byName.set(key, { ...existing, ...patch, name: patch.name ?? existing.name });
    };

    for (const entry of files.usercache) {
      if (entry.name) upsert(entry.name, { uuid: entry.uuid ?? null });
    }
    for (const entry of files.whitelist) {
      if (entry.name) upsert(entry.name, { whitelisted: true, uuid: entry.uuid ?? null });
    }
    for (const entry of files.ops) {
      if (entry.name) upsert(entry.name, { op: true, uuid: entry.uuid ?? null });
    }
    for (const entry of files.banned) {
      if (entry.name) upsert(entry.name, { banned: true, uuid: entry.uuid ?? null });
    }
    for (const name of online) {
      upsert(name, { online: true });
    }

    const players = [...byName.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1; // онлайн — угорі
      return a.name.localeCompare(b.name);
    });

    const properties = readServerProperties(record.dataDir);
    const whitelistEnabled =
      properties.entries.find((e) => e.key === 'white-list')?.value === 'true';

    return {
      players,
      onlineCount: online.size,
      rconAvailable,
      whitelistEnabled,
      warning,
    };
  }

  // ------------------------------------------------------------------- дії

  /**
   * Виконує дію над гравцем. Повертає відповідь сервера (RCON) або
   * повідомлення про надсилання без підтвердження (stdin-фолбек).
   */
  async performAction(
    record: ServerRecord,
    playerName: string,
    action: PlayerAction,
  ): Promise<{ output: string; confirmed: boolean }> {
    if (!PLAYER_NAME_PATTERN.test(playerName)) {
      throw new BadRequestError('Недопустимий нік гравця');
    }
    if (!record.containerId || !(await this.isRunning(record.containerId))) {
      throw new ConflictError('Сервер не запущено — керування гравцями недоступне');
    }

    const command = ACTION_COMMANDS[action](playerName);
    try {
      const result = await this.containers.execCapture(record.containerId, [
        'rcon-cli',
        ...command.split(' '),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(result.output || `rcon-cli завершився з кодом ${result.exitCode}`);
      }
      this.log.info(`Гравці (${record.name}): ${command} → ${result.output || 'ok'}`);
      return { output: result.output || 'Виконано', confirmed: true };
    } catch {
      // RCON недоступний — надсилаємо у stdin (без відповіді сервера).
      await this.gateway.sendCommand(record, command);
      this.log.warn(`Гравці (${record.name}): ${command} надіслано через stdin (RCON недоступний)`);
      return {
        output: 'Команду надіслано у консоль (RCON недоступний — без підтвердження виконання)',
        confirmed: false,
      };
    }
  }

  // -------------------------------------------------------------- допоміжне

  private async isRunning(containerId: string): Promise<boolean> {
    const state = await this.containers.inspectState(containerId).catch(() => null);
    return state?.running ?? false;
  }

  /** RCON `list` → множина ніків онлайн. */
  private async fetchOnline(containerId: string): Promise<Set<string>> {
    const result = await this.containers.execCapture(containerId, ['rcon-cli', 'list']);
    if (result.exitCode !== 0) {
      throw new Error(result.output || 'rcon-cli list failed');
    }
    const match = LIST_OUTPUT_PATTERN.exec(result.output);
    const names = (match?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      // Paper інколи додає суфікси/кольори — лишаємо тільки валідні ніки.
      .filter((name) => PLAYER_NAME_PATTERN.test(name));
    return new Set(names);
  }

  /** Безпечне читання JSON-списків сервера (відсутній/битий файл → порожньо). */
  private readPlayerFiles(dataDir: string): {
    usercache: PlayerFileEntry[];
    whitelist: PlayerFileEntry[];
    ops: PlayerFileEntry[];
    banned: PlayerFileEntry[];
  } {
    const readList = (file: string): PlayerFileEntry[] => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as unknown;
        return Array.isArray(parsed) ? (parsed as PlayerFileEntry[]) : [];
      } catch {
        return [];
      }
    };
    return {
      usercache: readList('usercache.json'),
      whitelist: readList('whitelist.json'),
      ops: readList('ops.json'),
      banned: readList('banned-players.json'),
    };
  }
}
