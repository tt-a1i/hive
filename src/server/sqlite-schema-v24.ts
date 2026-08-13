import type { Database } from 'better-sqlite3'

export const applySchemaVersion24 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT,
      source_ref TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks (workspace_id, status);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      dispatch_id TEXT,
      payload TEXT,
      line_snapshot TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, created_at);

    CREATE TABLE IF NOT EXISTS discussion_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      phase_key TEXT NOT NULL,
      agent_run_id TEXT,
      sync_kind TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_sync_log_member
      ON discussion_sync_log (member_id, group_id);
  `)

  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!columns.has('task_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN task_id TEXT')
  }
}
