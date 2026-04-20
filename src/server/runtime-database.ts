import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'

import { initializeRuntimeDatabase } from './sqlite-schema.js'

export const openRuntimeDatabase = (dataDir?: string): Database | undefined => {
  if (!dataDir) return undefined
  mkdirSync(dataDir, { recursive: true })
  const database = new BetterSqlite3(join(dataDir, 'runtime.sqlite'))
  initializeRuntimeDatabase(database)
  return database
}
