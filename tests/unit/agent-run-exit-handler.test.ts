import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { handleAgentRunExit } from '../../src/server/agent-run-exit-handler.js'
import type { AgentRunExitContext } from '../../src/server/agent-run-start-context.js'
import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'
import { createAgentTokenRegistry } from '../../src/server/agent-tokens.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'

const waitForResolvedExit = async (promise: Promise<void>) =>
  Promise.race([
    promise.then(() => 'resolved' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ])

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const writeCodexSession = (cwd: string, sessionId: string, content?: string) => {
  const root = join(tmpdir(), `hive-agent-exit-codex-home-${crypto.randomUUID()}`)
  const sessionDir = join(root, 'sessions', '2026', '07', '07')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`),
    content ?? `${JSON.stringify({ payload: { cwd, id: sessionId }, type: 'session_meta' })}\n`
  )
  tempDirs.push(root)
  process.env.CODEX_HOME = root
}

const createContext = (overrides: {
  clearLastSessionId?: AgentRunExitContext['sessionStore']['clearLastSessionId']
  getLastSessionId?: AgentRunExitContext['sessionStore']['getLastSessionId']
  onAgentExit?: AgentRunExitContext['onAgentExit']
  sessionCaptureDiscriminator?: AgentRunExitContext['sessionCaptureDiscriminator']
  startConfig?: AgentRunExitContext['startConfig']
  updatePersistedRun?: AgentRunExitContext['store']['updatePersistedRun']
  workspacePath?: string
}) => {
  const registry = createLiveRunRegistry()
  const tokenRegistry = createAgentTokenRegistry()
  const token = tokenRegistry.issue('agent-1')
  const liveRun: LiveAgentRun = {
    agentId: 'agent-1',
    exitCode: null,
    output: '',
    pid: 4242,
    runId: 'run-1',
    startedAt: 1000,
    status: 'running',
  }
  registry.createExitEntry(liveRun.runId)
  registry.add(liveRun)

  const context: AgentRunExitContext = {
    agentId: 'agent-1',
    handledRunExits: new Set(),
    onAgentExit: overrides.onAgentExit ?? vi.fn(),
    registry,
    sessionStore: {
      clearLastSessionId: overrides.clearLastSessionId ?? vi.fn(),
      getLastSessionId:
        overrides.getLastSessionId ??
        vi.fn(() => overrides.startConfig?.resumedSessionId ?? undefined),
      setLastSessionId: vi.fn(),
    },
    ...(overrides.sessionCaptureDiscriminator
      ? { sessionCaptureDiscriminator: overrides.sessionCaptureDiscriminator }
      : {}),
    startConfig: overrides.startConfig ?? {},
    store: {
      insertAgentRun: vi.fn(),
      updatePersistedRun: overrides.updatePersistedRun ?? vi.fn(),
    },
    token,
    tokenRegistry,
    workspace: {
      id: 'workspace-1',
      name: 'Workspace',
      path: overrides.workspacePath ?? 'C:\\repo',
    },
  }

  return { context, liveRun, registry, token, tokenRegistry }
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('handleAgentRunExit cleanup', () => {
  test('releases token, pending exit, and waiters when the DB update throws', async () => {
    const { context, registry, token, tokenRegistry } = createContext({
      updatePersistedRun: () => {
        throw new Error('database failed')
      },
    })
    const exitEntry = registry.getExitEntry('run-1')
    if (!exitEntry) throw new Error('expected exit entry')

    expect(() =>
      handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })
    ).toThrow('database failed')

    expect(tokenRegistry.validate('agent-1', token)).toBe(false)
    expect(registry.hasPendingExitCode('run-1')).toBe(false)
    expect(await waitForResolvedExit(exitEntry.promise)).toBe('resolved')
    expect(context.handledRunExits.has('run-1')).toBe(true)
  })

  test('releases token, pending exit, and waiters when markAgentStopped throws', async () => {
    const { context, registry, token, tokenRegistry } = createContext({
      onAgentExit: () => {
        throw new Error('mark stopped failed')
      },
    })
    const exitEntry = registry.getExitEntry('run-1')
    if (!exitEntry) throw new Error('expected exit entry')

    expect(() =>
      handleAgentRunExit(context, { endedAt: 2000, exitCode: 0, runId: 'run-1' })
    ).toThrow('mark stopped failed')

    expect(tokenRegistry.validate('agent-1', token)).toBe(false)
    expect(registry.hasPendingExitCode('run-1')).toBe(false)
    expect(await waitForResolvedExit(exitEntry.promise)).toBe('resolved')
    expect(context.handledRunExits.has('run-1')).toBe(true)
  })

  test('preserves resumed session id after non-zero live exit when captured Codex session still exists', () => {
    const cwd = join(tmpdir(), `hive-agent-exit-workspace-${crypto.randomUUID()}`)
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    mkdirSync(cwd, { recursive: true })
    tempDirs.push(cwd)
    writeCodexSession(cwd, sessionId)
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      startConfig: {
        resumedSessionId: sessionId,
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      },
      workspacePath: cwd,
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).not.toHaveBeenCalled()
  })

  test('preserves resumed session id when matching Codex session file is temporarily unreadable', () => {
    const cwd = join(tmpdir(), `hive-agent-exit-workspace-${crypto.randomUUID()}`)
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    mkdirSync(cwd, { recursive: true })
    tempDirs.push(cwd)
    writeCodexSession(cwd, sessionId, '{')
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      startConfig: {
        resumedSessionId: sessionId,
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      },
      workspacePath: cwd,
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).not.toHaveBeenCalled()
  })

  test('clears resumed session id after non-zero live exit when captured Codex session is gone', () => {
    const cwd = join(tmpdir(), `hive-agent-exit-workspace-${crypto.randomUUID()}`)
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    mkdirSync(cwd, { recursive: true })
    tempDirs.push(cwd)
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      startConfig: {
        resumedSessionId: sessionId,
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      },
      workspacePath: cwd,
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).toHaveBeenCalledWith('workspace-1', 'agent-1')
  })

  test('clears resumed session id after non-zero live exit when captured Gemini session is gone', () => {
    const cwd = join(tmpdir(), `hive-agent-exit-workspace-${crypto.randomUUID()}`)
    const sessionId = '29405746-aa9b-40bf-961b-f3d77fdcda40'
    mkdirSync(cwd, { recursive: true })
    tempDirs.push(cwd)
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      startConfig: {
        resumedSessionId: sessionId,
        sessionIdCapture: {
          pattern: '~/.gemini/tmp/*/chats/*.json',
          source: 'gemini_session_json_dir',
        },
      },
      workspacePath: cwd,
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).toHaveBeenCalledWith('workspace-1', 'agent-1')
  })

  test('does not clear when a newer session id was saved after this resumed run started', () => {
    const cwd = join(tmpdir(), `hive-agent-exit-workspace-${crypto.randomUUID()}`)
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    mkdirSync(cwd, { recursive: true })
    tempDirs.push(cwd)
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      getLastSessionId: vi.fn(() => 'newer-session-id'),
      startConfig: {
        resumedSessionId: sessionId,
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      },
      workspacePath: cwd,
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).not.toHaveBeenCalled()
  })

  test('preserves resumed session id after non-zero live exit for unverifiable stdout capture', () => {
    const clearLastSessionId = vi.fn()
    const { context } = createContext({
      clearLastSessionId,
      startConfig: {
        resumedSessionId: 'hermes-session-1',
        sessionIdCapture: {
          pattern: String.raw`Session:\s*([A-Za-z0-9_-]+)`,
          source: 'stdout_regex',
        },
      },
    })

    expect(handleAgentRunExit(context, { endedAt: 2000, exitCode: 1, runId: 'run-1' })).toBe(true)

    expect(clearLastSessionId).not.toHaveBeenCalled()
  })
})
