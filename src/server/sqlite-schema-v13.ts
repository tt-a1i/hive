import type { Database } from 'better-sqlite3'

import { applySchemaVersion12 } from './sqlite-schema-v12.js'

export const applySchemaVersion13 = (db: Database) => {
  applySchemaVersion12(db)
}
