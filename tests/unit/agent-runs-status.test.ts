import '../helpers/mock-node-pty.ts'

import { describe, expect, test } from 'vitest'

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

describe('agent run status model (unit)', () => {
  test('agent runtime exposes starting -> running -> exited transitions', async () => {
    let currentStatus: 'starting' | 'running' | 'exited' | 'error' = 'starting'

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: currentStatus === 'exited' ? 0 : null,
          output: currentStatus === 'running' || currentStatus === 'exited' ? 'ready' : '',
          pid: 1,
          runId: 'run-1',
          status: currentStatus,
        }),
        startAgent: async (input) => {
          currentStatus = 'starting'
          setTimeout(() => {
            currentStatus = 'running'
          }, 0)
          setTimeout(() => {
            currentStatus = 'exited'
            input.onExit?.({ runId: 'run-1', exitCode: 0 })
          }, 10)
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
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => undefined,
      () => {}
    )

    const run = await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    expect(run.status).toBe('starting')
  })
})
