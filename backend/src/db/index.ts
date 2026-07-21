import Database from 'better-sqlite3';

/**
 * Відкриває (створюючи за потреби) локальну SQLite-БД панелі та застосовує міграції.
 *
 * better-sqlite3 — синхронний драйвер: для десктопного інструмента з одиничними
 * запитами це найпростіший і найнадійніший варіант без пулів і колбеків.
 */
export function openDatabase(dbFile: string): Database.Database {
  const db = new Database(dbFile);
  // WAL дає коректну роботу при паралельних читаннях і кращу стійкість до збоїв.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Найпростіші "міграції вперед": тримаємо версію схеми у user_version
 * і послідовно застосовуємо кроки. Для локальної БД цього достатньо.
 */
function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL COLLATE NOCASE UNIQUE,
        kind          TEXT NOT NULL,
        version       TEXT NOT NULL,
        host_port     INTEGER NOT NULL UNIQUE,
        memory_mb     INTEGER NOT NULL,
        data_dir      TEXT NOT NULL,
        container_id  TEXT,
        status        TEXT NOT NULL DEFAULT 'provisioning',
        status_detail TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 1');
  }

  if (version < 2) {
    // v2: версія ядра (білд Paper / лоадер Fabric) і ліміт CPU.
    // Для старих записів NULL = «остання версія» і «без ліміту» відповідно.
    db.exec(`
      ALTER TABLE servers ADD COLUMN core_version TEXT;
      ALTER TABLE servers ADD COLUMN cpu_cores REAL;
    `);
    db.pragma('user_version = 2');
  }

  if (version < 3) {
    // v3: офлайн-режим і автопрегенерація Chunky.
    db.exec(`
      ALTER TABLE servers ADD COLUMN online_mode INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE servers ADD COLUMN pregen_radius INTEGER;
      ALTER TABLE servers ADD COLUMN pregen_done INTEGER NOT NULL DEFAULT 0;
    `);
    db.pragma('user_version = 3');
  }
}
