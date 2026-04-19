import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { encodeClaudeProjectPath } from '../../src/server/claude-session-support.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const tempDirs: string[] = []

const createClaudeSessionRoot = (cwd: string, sessionId: string) => {
  const root = join(tmpdir(), `hive-resume-failure-${crypto.randomUUID()}`)
  const projectDir = join(root, encodeClaudeProjectPath(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{}\n')
  tempDirs.push(root)
  process.env.HIVE_CLAUDE_PROJECTS_DIR = root
}

afterEach(() => {
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('claude session resume failure', () => {
  test('clears stale session id after resumed Claude run exits non-zero and next start is bare', async () => {
    const cwd = '/tmp/hive-resume-failure-workspace'
    const staleSessionId = '77777777-7777-4777-8777-777777777777'
    createClaudeSessionRoot(cwd, staleSessionId)
    const dbPath = join(tmpdir(), `hive-resume-failure-db-${crypto.randomUUID()}.sqlite`)
    const db = new Database(dbPath)
    tempDirs.push(dbPath)
    initializeRuntimeDatabase(db)
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'Alpha',
      cwd,
      Date.now()
    )
    db.prepare(
      'INSERT INTO workers (id, workspace_id, name, description, role, last_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('agent-1', 'ws-1', 'Alice', 'Coder', 'coder', staleSessionId, Date.now())
    db.prepare(
      'INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
    ).run('agent-1', 'ws-1', staleSessionId, Date.now())
    const sessionStore = createAgentSessionStore(db)
    let runIndex = 0
    const startArgs: Array<string[] | undefined> = []
    const runtime = createAgentRuntime(
      {
        getRun: (runId) => ({
          agentId: 'agent-1',
          exitCode: runId === 'run-1' ? 1 : null,
          output: '',
          pid: 1,
          runId,
          status: runId === 'run-1' ? 'error' : 'running',
        }),
        startAgent: async (input) => {
          runIndex += 1
          const runId = `run-${runIndex}`
          startArgs.push(input.args)
          if (runId === 'run-1') {
            input.onExit?.({ runId, exitCode: 1 })
          }
          return {
            agentId: 'agent-1',
            exitCode: runId === 'run-1' ? 1 : null,
            output: '',
            pid: 1,
            runId,
            status: runId === 'run-1' ? 'error' : 'starting',
          }
        },
        getOutputBus: () => outputBus,
        pauseRun: () => {},
        removeRun: () => {},
        resizeRun: () => {},
        resumeRun: () => {},
        stopRun: () => {},
        writeInput: () => {},
      },
      {
        initialize: () => {},
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [
          {
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            config: {
              command: 'claude',
              args: ['--dangerously-skip-permissions'],
              resumeArgsTemplate: '--resume {session_id}',
              sessionIdCapture: null,
            },
          },
        ],
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => {}
    )

    await runtime.startAgent({ id: 'ws-1', name: 'A', path: cwd }, 'agent-1', { hivePort: '4010' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await runtime.startAgent({ id: 'ws-1', name: 'A', path: cwd }, 'agent-1', { hivePort: '4010' })

    expect(startArgs[0]).toEqual(['--resume', staleSessionId, '--dangerously-skip-permissions'])
    expect(startArgs[1]).toEqual(['--dangerously-skip-permissions'])
    expect(sessionStore.getLastSessionId('ws-1', 'agent-1')).toBeUndefined()
    expect(
      db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get('agent-1') as {
        last_session_id: string | null
      }
    ).toEqual({ last_session_id: null })

    db.close()
  })
})
