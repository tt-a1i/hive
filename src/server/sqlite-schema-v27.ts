import type { Database } from 'better-sqlite3'

export const applySchemaVersion27 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!columns.has('seq')) {
    db.exec('ALTER TABLE tasks ADD COLUMN seq INTEGER')

    const rows = db
      .prepare('SELECT id, workspace_id FROM tasks ORDER BY workspace_id, created_at ASC')
      .all() as Array<{ id: string; workspace_id: string }>

    const counters = new Map<string, number>()
    const stmt = db.prepare('UPDATE tasks SET seq = ? WHERE id = ?')
    for (const row of rows) {
      const next = (counters.get(row.workspace_id) ?? 0) + 1
      counters.set(row.workspace_id, next)
      stmt.run(next, row.id)
    }

    db.exec('CREATE UNIQUE INDEX idx_tasks_workspace_seq ON tasks (workspace_id, seq)')
  }
}
