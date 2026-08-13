import type { Database } from 'better-sqlite3'

export const applySchemaVersion23 = (db: Database) => {
  db.exec(`
    ALTER TABLE role_templates ADD COLUMN discussion_triggers TEXT;
  `)
}
