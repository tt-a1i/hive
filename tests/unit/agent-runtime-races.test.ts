import '../helpers/mock-node-pty.ts'

import { describe, expect, test, vi } from 'vitest'

import { createAgentRuntime } from '../../src/server/agent-runtime.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const sessionStore = {
  clearLastSessionId: () => {},
  getLastSessionId: () => undefined,
  setLastSessionId: () => {},
}

describe('agent runtime races (unit)', () => {
  test('onExit that fires immediately still leaves persisted run not stuck in running', async () => {
    const updates: Array<{ runId: string; status: string; exitCode: number | null }> = []

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: 0,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'exited',
        }),
        startAgent: async (input) => {
          input.onExit?.({ exitCode: 0, runId: 'run-1' })
          return {
            agentId: 'agent-1',
            exitCode: null,
            output: '',
            pid: 1,
            runId: 'run-1',
            status: 'starting',
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
          { workspaceId: 'ws-1', agentId: 'agent-1', config: { command: '/bin/bash', args: [] } },
        ],
        saveLaunchConfig: () => {},
        updatePersistedRun: (runId, status, exitCode) => {
          updates.push({ runId, status, exitCode })
        },
      },
      sessionStore,
      () => {}
    )

    await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    expect(updates).toContainEqual({ runId: 'run-1', status: 'exited', exitCode: 0 })
  })

  test('stopAgentRun is idempotent for an already stopped run', () => {
    const stopSpy = vi.fn()
    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: 0,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'exited',
        }),
        startAgent: async () => ({
          agentId: 'agent-1',
          exitCode: 0,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'exited',
        }),
        getOutputBus: () => outputBus,
        pauseRun: () => {},
        removeRun: () => {},
        resizeRun: () => {},
        resumeRun: () => {},
        stopRun: stopSpy,
        writeInput: () => {},
      },
      {
        initialize: () => {},
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [],
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => {}
    )

    runtime.stopAgentRun('run-1')
    runtime.stopAgentRun('run-1')
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('failed stdin write surfaces PtyInactiveError so callers can skip message recording', async () => {
    const writes: string[] = []

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: 'ready',
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
          status: 'starting',
        }),
        getOutputBus: () => outputBus,
        pauseRun: () => {},
        removeRun: () => {},
        resizeRun: () => {},
        resumeRun: () => {},
        stopRun: () => {},
        writeInput: (_runId, text) => {
          writes.push(text)
          throw new Error('EPIPE')
        },
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

    await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    expect(() =>
      runtime.writeSendPrompt('ws-1', 'agent-1', 'Orchestrator', 'Coder role', 'Implement login')
    ).toThrow(/EPIPE/)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('Implement login')
    expect(writes[0]).toContain('@Orchestrator')
  })

  test('does not retain live run when persisted insert fails', async () => {
    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: '',
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
          status: 'starting',
        }),
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
        insertAgentRun: () => {
          throw new Error('sqlite insert failed')
        },
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

    await expect(
      runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
        hivePort: '4010',
      })
    ).rejects.toThrow(/sqlite insert failed/)

    expect(() => runtime.getLiveRun('run-1')).toThrow(/Live run not found/)
  })
})
