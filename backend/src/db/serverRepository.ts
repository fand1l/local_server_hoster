import type { Database } from 'better-sqlite3';
import type { ProvisionStatus, ServerKind, ServerRecord } from '../types.js';

/** Сирий рядок таблиці servers (snake_case, як у SQLite). */
interface ServerRow {
  id: string;
  name: string;
  kind: string;
  version: string;
  core_version: string | null;
  host_port: number;
  memory_mb: number;
  cpu_cores: number | null;
  data_dir: string;
  container_id: string | null;
  status: string;
  status_detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Поля, які дозволено оновлювати через update(). */
export interface ServerPatch {
  name?: string;
  memoryMb?: number;
  cpuCores?: number | null;
  containerId?: string | null;
  status?: ProvisionStatus;
  statusDetail?: string | null;
}

function rowToRecord(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ServerKind,
    version: row.version,
    coreVersion: row.core_version,
    hostPort: row.host_port,
    memoryMb: row.memory_mb,
    cpuCores: row.cpu_cores,
    dataDir: row.data_dir,
    containerId: row.container_id,
    status: row.status as ProvisionStatus,
    statusDetail: row.status_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Репозиторій серверів — єдина точка доступу до таблиці `servers`.
 * Уся конвертація camelCase <-> snake_case ізольована тут.
 */
export class ServerRepository {
  constructor(private readonly db: Database) {}

  list(): ServerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM servers ORDER BY created_at ASC')
      .all() as ServerRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): ServerRecord | null {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as
      | ServerRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByName(name: string): ServerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE name = ? COLLATE NOCASE')
      .get(name) as ServerRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByPort(hostPort: number): ServerRecord | null {
    const row = this.db.prepare('SELECT * FROM servers WHERE host_port = ?').get(hostPort) as
      | ServerRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  insert(record: ServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO servers
           (id, name, kind, version, core_version, host_port, memory_mb, cpu_cores,
            data_dir, container_id, status, status_detail, created_at, updated_at)
         VALUES
           (@id, @name, @kind, @version, @coreVersion, @hostPort, @memoryMb, @cpuCores,
            @dataDir, @containerId, @status, @statusDetail, @createdAt, @updatedAt)`,
      )
      .run(record);
  }

  /** Частково оновлює запис. Повертає оновлений запис або null, якщо id не існує. */
  update(id: string, patch: ServerPatch): ServerRecord | null {
    // Білий список колонок захищає від випадкового SQL-впорскування через імена полів.
    const columnByField: Record<keyof ServerPatch, string> = {
      name: 'name',
      memoryMb: 'memory_mb',
      cpuCores: 'cpu_cores',
      containerId: 'container_id',
      status: 'status',
      statusDetail: 'status_detail',
    };

    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
    for (const [field, column] of Object.entries(columnByField) as Array<
      [keyof ServerPatch, string]
    >) {
      if (field in patch) {
        sets.push(`${column} = @${field}`);
        params[field] = patch[field] ?? null;
      }
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE servers SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`)
        .run(params);
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  }
}
