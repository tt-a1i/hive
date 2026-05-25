import type { Database } from 'better-sqlite3'

export const applySchemaVersion29 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!columns.has('tmux_session')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN tmux_session TEXT')
  }
}
