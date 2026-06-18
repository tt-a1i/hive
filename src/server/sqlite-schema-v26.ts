import type { Database } from 'better-sqlite3'

export const applySchemaVersion26 = (db: Database) => {
  const wsColumns = new Set(
    (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!wsColumns.has('sort_order')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    const rows = db.prepare('SELECT id FROM workspaces ORDER BY created_at ASC').all() as Array<{
      id: string
    }>
    const stmt = db.prepare('UPDATE workspaces SET sort_order = ? WHERE id = ?')
    rows.forEach((row, i) => stmt.run(i, row.id))
  }

  const rtColumns = new Set(
    (db.prepare('PRAGMA table_info(role_templates)').all() as Array<{ name: string }>).map(
      (col) => col.name
    )
  )
  if (!rtColumns.has('use_count')) {
    db.exec('ALTER TABLE role_templates ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0')
  }
}
