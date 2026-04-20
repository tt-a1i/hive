import type { Database } from 'better-sqlite3'

export const applySchemaVersion8 = (db: Database) => {
  const launchConfigColumns = new Set(
    (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!launchConfigColumns.has('command_preset_id')) {
    db.exec('ALTER TABLE agent_launch_configs ADD COLUMN command_preset_id TEXT')
  }
}
