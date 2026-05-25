import type { Database } from 'better-sqlite3'

export const applySchemaVersion25 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(role_templates)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!columns.has('suggested_name')) {
    db.exec('ALTER TABLE role_templates ADD COLUMN suggested_name TEXT')
  }
  if (!columns.has('command_preset_id')) {
    db.exec('ALTER TABLE role_templates ADD COLUMN command_preset_id TEXT')
  }
}
