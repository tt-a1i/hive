import type { Database } from 'better-sqlite3'

const getDispatchColumns = (db: Database) =>
  new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

const createDispatchIndexes = (db: Database) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_created_at
      ON dispatches (workspace_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatches_open_by_worker
      ON dispatches (workspace_id, to_agent_id, status, sequence);
  `)
}

export const applySchemaVersion15 = (db: Database) => {
  const dispatchColumns = getDispatchColumns(db)
  if (dispatchColumns.size === 0) return

  db.exec(`
    DROP INDEX IF EXISTS idx_dispatches_workspace_created_at;
    DROP INDEX IF EXISTS idx_dispatches_open_by_worker;
  `)

  if (!dispatchColumns.has('sequence')) {
    db.exec(`
      ALTER TABLE dispatches RENAME TO dispatches_legacy_v15;

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );

      INSERT INTO dispatches (
        id,
        workspace_id,
        from_agent_id,
        to_agent_id,
        text,
        status,
        created_at,
        delivered_at,
        submitted_at,
        reported_at,
        report_text,
        artifacts
      )
      SELECT
        id,
        workspace_id,
        from_agent_id,
        to_agent_id,
        text,
        status,
        created_at,
        delivered_at,
        submitted_at,
        reported_at,
        report_text,
        artifacts
      FROM dispatches_legacy_v15
      ORDER BY created_at ASC, rowid ASC;

      DROP TABLE dispatches_legacy_v15;
    `)
  }

  createDispatchIndexes(db)
}
