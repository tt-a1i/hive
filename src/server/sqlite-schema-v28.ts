import type { Database } from 'better-sqlite3'

export const applySchemaVersion28 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!columns.has('checkpoint_json')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN checkpoint_json TEXT')
  }
}
