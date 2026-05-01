import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { withPresetResumeArgs } from '../../src/server/claude-session-support.js'
import {
  captureClaudeSessionId,
  encodeClaudeProjectPath,
  hasClaudeSessionFile,
  resetClaudeSessionClaimsForTests,
  snapshotClaudeSessionIds,
} from '../../src/server/session-capture-claude.js'

const tempDirs: string[] = []
const presetCapture = {
  source: 'claude_project_jsonl_dir' as const,
  pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
}

const createTempRoot = () => {
  const root = join(tmpdir(), `hive-claude-session-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  process.env.HIVE_CLAUDE_PROJECTS_DIR = root
  return root
}

const writeSession = (root: string, cwd: string, sessionId: string) => {
  const projectDir = join(root, encodeClaudeProjectPath(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{}\n')
}

afterEach(() => {
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  resetClaudeSessionClaimsForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('claude session support', () => {
  test('snapshotClaudeSessionIds returns an empty set when the project directory is missing', () => {
    createTempRoot()

    expect(snapshotClaudeSessionIds('/tmp/missing-project')).toEqual(new Set())
  })

  test('snapshotClaudeSessionIds returns only jsonl session ids', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-a'
    writeSession(root, cwd, '11111111-1111-4111-8111-111111111111')
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    writeFileSync(join(projectDir, 'not-a-session.txt'), 'ignore')

    expect(snapshotClaudeSessionIds(cwd)).toEqual(new Set(['11111111-1111-4111-8111-111111111111']))
  })

  test('snapshotClaudeSessionIds ignores malformed jsonl names', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-b'
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'bad.jsonl'), '{}\n')

    expect(snapshotClaudeSessionIds(cwd)).toEqual(new Set())
  })

  test('captureClaudeSessionId resolves undefined when no new id appears before timeout', async () => {
    createTempRoot()
    const captured: string[] = []

    await captureClaudeSessionId(
      '/tmp/project-c',
      new Set(),
      (sessionId) => captured.push(sessionId),
      10,
      1
    )

    expect(captured).toEqual([])
  })

  test('captureClaudeSessionId captures a new session id', async () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-d'
    writeSession(root, cwd, '22222222-2222-4222-8222-222222222222')
    const captured: string[] = []

    await captureClaudeSessionId(cwd, new Set(), (sessionId) => captured.push(sessionId), 50, 1)

    expect(captured).toEqual(['22222222-2222-4222-8222-222222222222'])
  })

  test('captureClaudeSessionId skips ids already present in the startup snapshot', async () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-e'
    writeSession(root, cwd, '33333333-3333-4333-8333-333333333333')
    const captured: string[] = []
    setTimeout(() => writeSession(root, cwd, '44444444-4444-4444-8444-444444444444'), 5)

    await captureClaudeSessionId(
      cwd,
      new Set(['33333333-3333-4333-8333-333333333333']),
      (sessionId) => captured.push(sessionId),
      50,
      1
    )

    expect(captured).toEqual(['44444444-4444-4444-8444-444444444444'])
  })

  test('withPresetResumeArgs returns original config when no last session exists', () => {
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: presetCapture,
    }

    expect(withPresetResumeArgs(config, null, undefined)).toBe(config)
  })

  test('withPresetResumeArgs adds resume args when the session file exists', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-f'
    writeSession(root, cwd, '55555555-5555-4555-8555-555555555555')

    expect(
      withPresetResumeArgs(
        {
          command: 'claude',
          args: ['--dangerously-skip-permissions'],
        },
        {
          resumeArgsTemplate: '--resume {session_id}',
          sessionIdCapture: presetCapture,
          yoloArgsTemplate: null,
        },
        '55555555-5555-4555-8555-555555555555',
        cwd
      )
    ).toMatchObject({
      args: ['--resume', '55555555-5555-4555-8555-555555555555', '--dangerously-skip-permissions'],
      resumedSessionId: '55555555-5555-4555-8555-555555555555',
    })
  })

  test('withPresetResumeArgs returns original config when the session file is stale', () => {
    createTempRoot()
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: presetCapture,
    }

    expect(
      withPresetResumeArgs(config, null, '66666666-6666-4666-8666-666666666666', '/tmp/project-g')
    ).toBe(config)
    expect(hasClaudeSessionFile('/tmp/project-g', '66666666-6666-4666-8666-666666666666')).toBe(
      false
    )
  })

  test('withPresetResumeArgs trusts Codex last_session_id without a filesystem preflight', () => {
    const result = withPresetResumeArgs(
      {
        command: 'codex',
        args: [],
      },
      {
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          source: 'codex_session_jsonl_dir',
          pattern: '~/.codex/sessions/**/*.jsonl',
        },
        yoloArgsTemplate: null,
      },
      '019dc277-0e8e-75c1-9794-94929426288e',
      '/tmp/no-such-codex-workspace'
    )

    expect(result).toMatchObject({
      args: ['resume', '019dc277-0e8e-75c1-9794-94929426288e'],
      resumedSessionId: '019dc277-0e8e-75c1-9794-94929426288e',
    })
  })

  test('withPresetResumeArgs skips resume when capture source is unsupported', () => {
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    }
    const result = withPresetResumeArgs(
      config,
      {
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          source: 'stdout_regex',
          pattern: 'Session ID: ([a-f0-9-]+)',
        },
        yoloArgsTemplate: null,
      },
      '77777777-7777-4777-8777-777777777777',
      '/tmp/project-h'
    )

    expect(result).toMatchObject({
      args: ['--dangerously-skip-permissions'],
    })
    expect(result).not.toHaveProperty('resumedSessionId')
  })
})
