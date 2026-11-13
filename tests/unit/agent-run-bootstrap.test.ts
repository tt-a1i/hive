import { describe, expect, test } from 'vitest'

import {
  buildAgentRunBootstrap,
  buildSpawnPathEnvEntry,
} from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStorePort } from '../../src/server/agent-runtime-ports.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'

const codexPreset: CommandPresetRecord = {
  args: [],
  command: 'codex',
  displayName: 'Codex',
  env: {},
  id: 'codex',
  isBuiltin: true,
  resumeArgsTemplate: 'resume {session_id}',
  sessionIdCapture: {
    pattern: '~/.codex/sessions/**/*.jsonl',
    source: 'codex_session_jsonl_dir',
  },
  yoloArgsTemplate: null,
}

const piPreset: CommandPresetRecord = {
  args: [],
  command: 'pi',
  displayName: 'Pi',
  env: {},
  id: 'pi',
  isBuiltin: true,
  resumeArgsTemplate: null,
  sessionIdCapture: null,
  yoloArgsTemplate: ['--approve'],
}

const createSessionStore = (sessionId: string): AgentSessionStorePort => ({
  clearLastSessionId: () => {},
  getLastSessionId: () => sessionId,
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('does not snapshot sessions before spawning when a preset resume id is available', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      createSessionStore(sessionId),
      (id) => (id === 'codex' ? codexPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    expect(bootstrap.sessionCaptureSnapshot).toBeUndefined()
  })

  test('applies Pi preset approval args before spawning', () => {
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-pi-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'pi',
        commandPresetId: 'pi',
      },
      createSessionStore(''),
      (id) => (id === 'pi' ? piPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['--approve'],
      command: 'pi',
      commandPresetId: 'pi',
    })
  })
})

describe('buildSpawnPathEnvEntry', () => {
  // The bug we're fixing: on Windows, `process.env` reports the PATH variable
  // under the OS's original casing (`Path` is the convention on Win10+). When
  // we build an env override object with `PATH: ...` and spread it into a
  // copy of `process.env` (which is what agent-manager does), the merged
  // object ends up with BOTH `Path` (from the spread) AND `PATH` (from the
  // override). CreateProcess then receives two entries for the same effective
  // variable; which one wins is undefined. In practice the original system
  // `Path` often shadows the new `PATH`, so `HIVE_BIN_DIR` never reaches the
  // child PTY's lookup table — breaking every `team` shim resolution.
  //
  // The fix: detect the existing casing and write to that exact key, so the
  // spread overwrites it cleanly with no duplicate.
  test('uses the literal PATH key on POSIX', () => {
    const entry = buildSpawnPathEnvEntry({ PATH: '/usr/bin' }, '/hive/bin', 'linux')
    expect(entry).toEqual({ PATH: '/hive/bin:/usr/bin' })
  })

  test('respects the OS-cased Path key on Windows', () => {
    // Windows env block on Win10+ reports `Path`; if we wrote `PATH`, the
    // merged object would carry both keys and the child PTY would see a
    // non-deterministic value.
    const entry = buildSpawnPathEnvEntry(
      { Path: 'C:\\Windows\\System32;C:\\Windows' },
      'C:\\hive\\dist\\bin',
      'win32'
    )
    expect(Object.keys(entry)).toEqual(['Path'])
    expect(entry).toEqual({
      Path: 'C:\\hive\\dist\\bin;C:\\Windows\\System32;C:\\Windows',
    })
  })

  test('case-insensitive match against any OS-reported casing', () => {
    // Some systems report `path` lowercase (Cygwin / older shells) — make
    // sure we still hit the existing key rather than introducing a new one.
    const entry = buildSpawnPathEnvEntry({ path: 'C:\\Windows' }, 'C:\\hive\\dist\\bin', 'win32')
    expect(Object.keys(entry)).toEqual(['path'])
    expect(entry).toEqual({ path: 'C:\\hive\\dist\\bin;C:\\Windows' })
  })

  test('falls back to PATH when Windows env has no PATH-like key', () => {
    // Very rare (PATH essentially always exists), but if it doesn't we should
    // still prepend HIVE_BIN_DIR rather than silently doing nothing.
    const entry = buildSpawnPathEnvEntry({}, 'C:\\hive\\dist\\bin', 'win32')
    expect(entry).toEqual({ PATH: 'C:\\hive\\dist\\bin' })
  })

  test('prefers an explicit PATH override over an older OS-cased Path on Windows', () => {
    const entry = buildSpawnPathEnvEntry(
      { Path: 'C:\\Windows', PATH: 'C:\\fake-bin;C:\\Windows' },
      'C:\\hive\\dist\\bin',
      'win32'
    )
    expect(Object.keys(entry)).toEqual(['PATH'])
    expect(entry).toEqual({ PATH: 'C:\\hive\\dist\\bin;C:\\fake-bin;C:\\Windows' })
  })

  test('handles missing PATH on POSIX by prepending alone', () => {
    const entry = buildSpawnPathEnvEntry({}, '/hive/bin', 'linux')
    expect(entry).toEqual({ PATH: '/hive/bin' })
  })

  test('a merge with the parent env replaces, not duplicates, the PATH key on Windows', () => {
    // This is the smoking-gun assertion: the regression we're preventing
    // is the duplicate-key case. After spread, the merged object must have
    // exactly one PATH-like key, and its value must be the new prepended PATH.
    const parentEnv = { Path: 'C:\\Windows', OTHER: 'untouched' }
    const entry = buildSpawnPathEnvEntry(parentEnv, 'C:\\hive\\dist\\bin', 'win32')
    const merged = { ...parentEnv, ...entry }
    const pathKeys = Object.keys(merged).filter((k) => k.toLowerCase() === 'path')
    expect(pathKeys).toEqual(['Path'])
    expect(merged.Path).toBe('C:\\hive\\dist\\bin;C:\\Windows')
  })
})
