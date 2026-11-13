import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  formatRuntimeDataDirOpenMessage,
  openRuntimeDatabase,
} from '../../src/server/runtime-database.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('runtime database startup diagnostics', () => {
  test('persistent databases use WAL and a busy timeout for transient Windows locks', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-runtime-db-pragma-'))
    tempDirs.push(root)

    const database = openRuntimeDatabase(root)
    try {
      expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    } finally {
      database.close()
    }
  })

  test.skipIf(process.platform === 'win32')(
    'restricts existing data directory and database permissions',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-runtime-permissions-'))
      tempDirs.push(root)
      const path = join(root, 'runtime.sqlite')
      writeFileSync(path, '')
      chmodSync(root, 0o755)
      chmodSync(path, 0o644)
      const db = openRuntimeDatabase(root)
      try {
        expect(statSync(root).mode & 0o777).toBe(0o700)
        expect(statSync(path).mode & 0o777).toBe(0o600)
      } finally {
        db.close()
      }
    }
  )

  test('memory databases still get the same busy timeout', () => {
    const database = openRuntimeDatabase()
    try {
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    } finally {
      database.close()
    }
  })

  test('formats data-dir failures with a HIVE_DATA_DIR recovery hint', () => {
    const message = formatRuntimeDataDirOpenMessage(
      'C:\\Users\\admin\\AppData\\Roaming\\hive',
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      'win32'
    )

    expect(message).toContain('Hive could not open its local data directory')
    expect(message).toContain('C:\\Users\\admin\\AppData\\Roaming\\hive')
    expect(message).toContain('HIVE_DATA_DIR')
    expect(message).toContain('PowerShell:')
    expect(message).toContain('cmd.exe:')
  })

  test('wraps real filesystem setup failures before Hive boot continues', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-runtime-db-startup-'))
    tempDirs.push(root)
    const dataDirAsFile = join(root, 'not-a-directory')
    writeFileSync(dataDirAsFile, 'not a directory')

    expect(() => openRuntimeDatabase(dataDirAsFile)).toThrow(/HIVE_DATA_DIR/)
  })

  test('preserves the built-in SQLite error for a corrupt existing database', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-runtime-db-corrupt-'))
    tempDirs.push(root)
    writeFileSync(join(root, 'runtime.sqlite'), 'this is not a SQLite database')
    expect(() => openRuntimeDatabase(root)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 26 }),
        message: expect.stringContaining('Hive found a damaged local database'),
      })
    )
  })
})
