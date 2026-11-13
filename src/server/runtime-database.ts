import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './sqlite.js'
import SqliteDatabase from './sqlite.js'

import { initializeRuntimeDatabase } from './sqlite-schema.js'

const hiveDataDirExamples = (platform: NodeJS.Platform = process.platform): string[] =>
  platform === 'win32'
    ? [
        '  PowerShell: $env:HIVE_DATA_DIR="C:\\HiveData"; hive',
        '  cmd.exe:    set HIVE_DATA_DIR=C:\\HiveData && hive',
      ]
    : ['  export HIVE_DATA_DIR="$HOME/.config/hive-data"', '  hive']

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = Reflect.get(error, 'code')
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

const isPermissionErrorCode = (code: string): boolean =>
  code === 'EACCES' || code === 'EPERM' || code === 'EROFS'

const closeQuietly = (database: Database | undefined): void => {
  if (!database) return
  try {
    database.close()
  } catch {
    // Keep the original open/init error; a close failure must not replace it.
  }
}

export const formatRuntimeDataDirOpenMessage = (
  dataDir: string,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): string => {
  const detail = error instanceof Error ? error.message : String(error)
  return [
    `Hive could not open its local data directory: ${dataDir}`,
    detail,
    '',
    'Choose a writable local folder and start Hive with HIVE_DATA_DIR set, for example:',
    ...hiveDataDirExamples(platform),
  ].join('\n')
}

export const formatRuntimeDatabaseFileOpenMessage = (
  dataDir: string,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): string => {
  const detail = error instanceof Error ? error.message : String(error)
  return [
    `Hive could not open its local database file: ${join(dataDir, 'runtime.sqlite')}`,
    detail,
    '',
    'The data directory exists. If this folder is not writable, start Hive with HIVE_DATA_DIR set, for example:',
    ...hiveDataDirExamples(platform),
  ].join('\n')
}

export const formatRuntimeDatabaseInitMessage = (
  dataDir: string | undefined,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): string => {
  const detail = error instanceof Error ? error.message : String(error)
  const code = errorCode(error)
  const sqliteCode =
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    typeof error.errcode === 'number'
      ? error.errcode & 0xff
      : undefined
  const dbPath = dataDir ? join(dataDir, 'runtime.sqlite') : 'in-memory'
  if ((code && isPermissionErrorCode(code)) || sqliteCode === 8) {
    if (!dataDir) {
      return [
        'Hive could not initialize an in-memory database (permission/readonly).',
        detail,
      ].join('\n')
    }
    return formatRuntimeDatabaseFileOpenMessage(dataDir, error, platform)
  }
  if (sqliteCode === 11 || sqliteCode === 26) {
    return [
      `Hive found a damaged local database: ${dbPath}`,
      detail,
      '',
      'This is not a folder-permission problem. Point HIVE_DATA_DIR at a new empty folder only if you want a fresh database.',
    ].join('\n')
  }
  return [
    `Hive could not finish initializing its local database: ${dbPath}`,
    detail,
    '',
    'This is not classified as a permissions error. The original error is preserved as cause.',
  ].join('\n')
}

const createRuntimeDataDirOpenError = (
  dataDir: string,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): Error => new Error(formatRuntimeDataDirOpenMessage(dataDir, error, platform), { cause: error })

const classifyDatabaseOpenError = (dataDir: string | undefined, error: unknown): Error =>
  new Error(
    dataDir
      ? formatRuntimeDatabaseFileOpenMessage(dataDir, error)
      : formatRuntimeDatabaseInitMessage(undefined, error),
    { cause: error }
  )

const classifyInitializationError = (dataDir: string | undefined, error: unknown): Error =>
  new Error(formatRuntimeDatabaseInitMessage(dataDir, error), { cause: error })

const configureRuntimeDatabase = (database: Database, input: { persistent: boolean }): void => {
  if (!input.persistent) return
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
}

export const openRuntimeDatabase = (dataDir?: string): Database => {
  let database: Database | undefined
  try {
    if (dataDir) {
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') chmodSync(dataDir, 0o700)
      } catch (error) {
        throw createRuntimeDataDirOpenError(dataDir, error)
      }
      try {
        const databasePath = join(dataDir, 'runtime.sqlite')
        const fd = openSync(databasePath, 'a', 0o600)
        closeSync(fd)
        if (process.platform !== 'win32') chmodSync(databasePath, 0o600)
        database = new SqliteDatabase(databasePath)
      } catch (error) {
        throw classifyDatabaseOpenError(dataDir, error)
      }
    } else {
      try {
        database = new SqliteDatabase(':memory:')
      } catch (error) {
        throw classifyDatabaseOpenError(undefined, error)
      }
    }
    try {
      configureRuntimeDatabase(database, { persistent: Boolean(dataDir) })
      initializeRuntimeDatabase(database)
    } catch (error) {
      throw classifyInitializationError(dataDir, error)
    }
    return database
  } catch (error) {
    closeQuietly(database)
    throw error
  }
}
