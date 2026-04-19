import type { Database } from 'better-sqlite3'

const legacyMessageTypeColumn = 'kind'

export const applySchemaVersion5 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (workerColumns.size > 0 && !workerColumns.has('last_session_id')) {
    db.exec('ALTER TABLE workers ADD COLUMN last_session_id TEXT')
  }

  const agentRunColumns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (agentRunColumns.size > 0 && !agentRunColumns.has('pid')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN pid INTEGER')
  }
  if (agentRunColumns.size > 0 && !agentRunColumns.has('ended_at')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN ended_at INTEGER')
  }

  const messageColumns = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!messageColumns.has(legacyMessageTypeColumn)) {
    return
  }

  db.exec(`
    ALTER TABLE messages RENAME TO messages_legacy;

    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      type TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT,
      text TEXT,
      status TEXT,
      artifacts TEXT,
      created_at INTEGER NOT NULL
    );

    INSERT INTO messages (
      sequence,
      workspace_id,
      worker_id,
      type,
      from_agent_id,
      to_agent_id,
      text,
      status,
      artifacts,
      created_at
    )
    SELECT
      sequence,
      workspace_id,
      worker_id,
      type,
      from_agent_id,
      to_agent_id,
      text,
      status,
      artifacts,
      created_at
    FROM messages_legacy;

    DROP TABLE messages_legacy;
  `)
}
