import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import {
  doesCapturedSessionExist,
  snapshotSessionIdsForCapture,
} from '../../src/server/session-capture.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalGeminiHome = process.env.HIVE_GEMINI_HOME
const originalOpenCodeDbPath = process.env.HIVE_OPENCODE_DB_PATH

const makeTempDir = (prefix: string) => {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalGeminiHome === undefined) delete process.env.HIVE_GEMINI_HOME
  else process.env.HIVE_GEMINI_HOME = originalGeminiHome
  if (originalOpenCodeDbPath === undefined) delete process.env.HIVE_OPENCODE_DB_PATH
  else process.env.HIVE_OPENCODE_DB_PATH = originalOpenCodeDbPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('multi-CLI session capture', () => {
  test('captures Codex sessions by cwd from CODEX_HOME session jsonl files', () => {
    const codexHome = makeTempDir('hive-codex-home')
    const cwd = join(codexHome, 'workspace')
    mkdirSync(cwd, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-2026-04-30T00-00-00-${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd, id: sessionId } })}\n`
    )

    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }

    expect(snapshotSessionIdsForCapture(cwd, capture)?.knownSessionIds).toEqual(
      new Set([sessionId])
    )
    expect(doesCapturedSessionExist(cwd, capture, sessionId)).toBe(true)
    expect(doesCapturedSessionExist(join(codexHome, 'other'), capture, sessionId)).toBe(false)
  })

  test('captures Gemini sessions by project root from GEMINI tmp chat json files', () => {
    const geminiHome = makeTempDir('hive-gemini-home')
    const cwd = join(geminiHome, 'workspace')
    mkdirSync(cwd, { recursive: true })
    process.env.HIVE_GEMINI_HOME = geminiHome
    const sessionId = '29405746-aa9b-40bf-961b-f3d77fdcda40'
    const projectDir = join(geminiHome, 'tmp', 'project-hash')
    mkdirSync(join(projectDir, 'chats'), { recursive: true })
    writeFileSync(join(projectDir, '.project_root'), `${cwd}\n`)
    writeFileSync(
      join(projectDir, 'chats', 'session-2026-04-30T00-00-29405746.json'),
      JSON.stringify({ sessionId })
    )

    const capture = {
      pattern: '~/.gemini/tmp/*/chats/*.json',
      source: 'gemini_session_json_dir' as const,
    }

    expect(snapshotSessionIdsForCapture(cwd, capture)?.knownSessionIds).toEqual(
      new Set([sessionId])
    )
    expect(doesCapturedSessionExist(cwd, capture, sessionId)).toBe(true)
    expect(doesCapturedSessionExist(join(geminiHome, 'other'), capture, sessionId)).toBe(false)
  })

  test('captures OpenCode sessions by directory from the session database', () => {
    const dataDir = makeTempDir('hive-opencode-data')
    const cwd = join(dataDir, 'workspace')
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(dataDir, 'opencode.db')
    process.env.HIVE_OPENCODE_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        time_archived INTEGER
      );
    `)
    db.prepare('INSERT INTO session (id, directory, time_archived) VALUES (?, ?, NULL)').run(
      'ses_25c8f572efferzSV4Mgjo99WqB',
      cwd
    )
    db.prepare('INSERT INTO session (id, directory, time_archived) VALUES (?, ?, ?)').run(
      'ses_archived',
      cwd,
      Date.now()
    )
    db.close()

    const capture = {
      pattern: '~/.local/share/opencode/opencode.db',
      source: 'opencode_session_db' as const,
    }

    expect(snapshotSessionIdsForCapture(cwd, capture)?.knownSessionIds).toEqual(
      new Set(['ses_25c8f572efferzSV4Mgjo99WqB'])
    )
    expect(doesCapturedSessionExist(cwd, capture, 'ses_25c8f572efferzSV4Mgjo99WqB')).toBe(true)
    expect(doesCapturedSessionExist(cwd, capture, 'ses_archived')).toBe(false)
  })
})
