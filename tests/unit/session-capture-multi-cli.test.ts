import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captureSessionIdForCapture,
  captureStdoutRegexSessionId,
  doesCapturedSessionExist,
  snapshotSessionIdsForCapture,
} from '../../src/server/session-capture.js'
import { readCodexSessionFirstLine } from '../../src/server/session-capture-codex.js'
import {
  hasOpenCodeSession,
  snapshotOpenCodeSessionIds,
} from '../../src/server/session-capture-opencode.js'
import Database from '../../src/server/sqlite.js'

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
  test('aborting one directory capture leaves its sibling able to claim the new session', async () => {
    const root = makeTempDir('hive-cancel-capture')
    const cwd = join(root, 'workspace')
    const capture = {
      source: 'codex_session_jsonl_dir' as const,
      pattern: join(root, 'sessions/**/*.jsonl'),
    }
    const snapshot = { knownSessionIds: new Set<string>(), root }
    const cancel = new AbortController()
    const received: string[] = []
    const stopped = captureSessionIdForCapture(
      cwd,
      capture,
      snapshot,
      (id) => received.push(`stopped:${id}`),
      5000,
      10,
      cancel.signal
    )
    const waiting = captureSessionIdForCapture(
      cwd,
      capture,
      snapshot,
      (id) => received.push(id),
      5000,
      10
    )
    cancel.abort()
    await stopped
    const id = '019dc277-0e8e-75c1-9794-94929426288e'
    const directory = join(root, 'sessions', '2026', '04', '30')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, `rollout-2026-04-30T00-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd, id } })}\n`
    )
    await waiting
    expect(received).toEqual([id])
  })

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

  test('reads only the bounded Codex jsonl header line instead of decoding the full rollout', () => {
    const codexHome = makeTempDir('hive-codex-header')
    const filePath = join(codexHome, 'rollout-large.jsonl')
    const firstLine = JSON.stringify({
      payload: { cwd: join(codexHome, 'workspace'), id: '019dc277-0e8e-75c1-9794-94929426288e' },
      type: 'session_meta',
    })
    writeFileSync(filePath, `${firstLine}\n${'x'.repeat(256 * 1024)}`)

    expect(readCodexSessionFirstLine(filePath, firstLine.length + 8)).toBe(firstLine)
    expect(readCodexSessionFirstLine(filePath, firstLine.length - 1)).toBeNull()
  })

  test('requires parseable Codex cwd metadata before a rollout filename match counts as existing', () => {
    const codexHome = makeTempDir('hive-codex-partial')
    const cwd = join(codexHome, 'workspace')
    mkdirSync(cwd, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, `rollout-2026-04-30T00-00-00-${sessionId}.jsonl`), '{')

    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }

    expect(doesCapturedSessionExist(cwd, capture, sessionId)).toBe(false)
    expect(doesCapturedSessionExist(join(codexHome, 'other-workspace'), capture, sessionId)).toBe(
      false
    )
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

  test('matches OpenCode session directories case-insensitively on win32', () => {
    const dataDir = makeTempDir('hive-opencode-win32')
    const dbPath = join(dataDir, 'opencode.db')
    const sessionId = 'ses_windows_path'
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        time_archived INTEGER
      );
    `)
    db.prepare('INSERT INTO session (id, directory, time_archived) VALUES (?, ?, NULL)').run(
      sessionId,
      'C:\\Users\\Admin\\workspace'
    )
    db.close()

    expect(snapshotOpenCodeSessionIds('c:/users/admin/workspace', dbPath, 'win32')).toEqual(
      new Set([sessionId])
    )
    expect(
      hasOpenCodeSession('c:/users/admin/workspace', sessionId, undefined, 'win32', dbPath)
    ).toBe(true)
    expect(snapshotOpenCodeSessionIds('c:/users/admin/workspace', dbPath, 'linux')).toEqual(
      new Set()
    )
  })

  test('captures Hermes-style session ids from PTY output with stdout_regex', async () => {
    let output = 'Hermes Agent v0.15.1\n'
    const captured: string[] = []

    setTimeout(() => {
      output += 'Session: 20260602_140311_be67e0\n❯ '
    }, 20)

    await captureStdoutRegexSessionId(
      String.raw`Session:\s*([A-Za-z0-9_-]+)`,
      () => output,
      new Set(),
      (sessionId) => captured.push(sessionId),
      500,
      10
    )

    expect(captured).toEqual(['20260602_140311_be67e0'])
  })

  test('stdout_regex capture fails closed when the regex is invalid or output is unavailable', async () => {
    const captured: string[] = []

    await captureStdoutRegexSessionId(
      '[',
      () => 'Session: should-not-parse',
      new Set(),
      (id) => captured.push(id)
    )
    await captureStdoutRegexSessionId(
      String.raw`Session:\s*([A-Za-z0-9_-]+)`,
      undefined,
      new Set(),
      (id) => captured.push(id)
    )

    expect(captured).toEqual([])
  })
})
