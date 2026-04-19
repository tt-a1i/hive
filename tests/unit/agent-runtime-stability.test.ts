import '../helpers/mock-node-pty.ts'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'

const sessionStore = {
  clearLastSessionId: () => {},
  getLastSessionId: () => undefined,
  setLastSessionId: () => {},
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
  vi.restoreAllMocks()
})

describe('agent runtime stability (unit)', () => {
  test('run output is capped at 1MB and keeps the tail', async () => {
    const largeOutput = 'a'.repeat(1_500_000)

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: largeOutput,
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
        startAgent: async () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
        removeRun: () => {},
        stopRun: () => {},
        writeInput: () => {},
      },
      {
        initialize: () => {},
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [
          { workspaceId: 'ws-1', agentId: 'agent-1', config: { command: '/bin/bash', args: [] } },
        ],
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => {}
    )

    const run = await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    const snapshot = runtime.getLiveRun(run.runId)
    expect(snapshot.output.length).toBeLessThanOrEqual(1_000_000)
    expect(snapshot.output.slice(-100)).toBe('a'.repeat(100))
  })

  test('invalid args_json falls back to empty args and warns', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bad-args-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ws-1', 'agent-1', '/bin/bash', '{bad json', null, null, Date.now(), Date.now())

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createAgentRunStore(db)
    const configs = store.listLaunchConfigs()

    expect(configs).toEqual([
      {
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        config: {
          command: '/bin/bash',
          args: [],
          resumeArgsTemplate: null,
          sessionIdCapture: null,
        },
      },
    ])
    expect(warnSpy).toHaveBeenCalled()

    db.close()
  })
})
