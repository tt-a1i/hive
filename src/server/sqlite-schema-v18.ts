import type { Database } from 'better-sqlite3'

export const applySchemaVersion18 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('interactive_command')) {
    db.exec('ALTER TABLE agent_launch_configs ADD COLUMN interactive_command TEXT')
  }
}
