import type { Database } from 'better-sqlite3'

export const applySchemaVersion22 = (db: Database) => {
  db.exec(`
    ALTER TABLE discussion_groups ADD COLUMN orch_participates INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE discussion_members ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  `)
}
