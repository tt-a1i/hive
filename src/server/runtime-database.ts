import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'

import { initializeRuntimeDatabase } from './sqlite-schema.js'

export const openRuntimeDatabase = (dataDir?: string): Database => {
  let database: Database
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    database = new BetterSqlite3(join(dataDir, 'runtime.sqlite'))
  } else {
    database = new BetterSqlite3(':memory:')
  }
  initializeRuntimeDatabase(database)
  return database
}
