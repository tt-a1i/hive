import type { Database } from 'better-sqlite3'

export const applySchemaVersion19 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('role_template_name')) {
    db.exec('ALTER TABLE workers ADD COLUMN role_template_name TEXT')
  }
}
