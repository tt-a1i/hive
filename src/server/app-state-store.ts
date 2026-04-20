import type { Database } from 'better-sqlite3'

export type AppStateValue = string | null

export interface AppStateRecord {
  key: string
  value: AppStateValue
}

export const createAppStateStore = (db: Database | undefined) => {
  const get = (key: string): AppStateRecord | undefined => {
    if (!db) return undefined
    const row = db.prepare('SELECT key, value FROM app_state WHERE key = ?').get(key) as
      | { key: string; value: string | null }
      | undefined
    return row ? { key: row.key, value: row.value } : undefined
  }

  const set = (key: string, value: AppStateValue) => {
    db?.prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, Date.now())
  }

  return { get, set }
}
