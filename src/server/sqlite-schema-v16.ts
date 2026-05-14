import type { Database } from 'better-sqlite3'

export const applySchemaVersion16 = (db: Database) => {
  const launchConfigColumns = new Set(
    (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!launchConfigColumns.has('preset_augmentation_disabled')) {
    db.exec(
      'ALTER TABLE agent_launch_configs ADD COLUMN preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0'
    )
  }
}
