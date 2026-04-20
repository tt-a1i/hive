import { afterEach, describe, expect, test, vi } from 'vitest'

const exitSequences: Array<number[]> = []

const waitFor = async (assertion: () => void, timeoutMs = 1000, intervalMs = 10) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

vi.mock('node-pty', () => ({
  spawn: () => {
    const exitCodes = exitSequences.shift() ?? [0, 0]
    let exitHandler: ((event: { exitCode: number }) => void) | undefined

    queueMicrotask(() => {
      for (const exitCode of exitCodes) {
        exitHandler?.({ exitCode })
      }
    })

    return {
      pid: 4242,
      kill() {},
      onData() {},
      onExit(handler: (event: { exitCode: number }) => void) {
        exitHandler = handler
      },
      write() {},
    }
  },
}))

import { createAgentManager } from '../../src/server/agent-manager.js'

afterEach(() => {
  exitSequences.length = 0
  vi.clearAllMocks()
})

describe('agent manager finishRun', () => {
  test('invokes onExit only once when PTY exit fires twice', async () => {
    exitSequences.push([0, 0])
    const manager = createAgentManager()
    const onExitSpy = vi.fn()

    const run = await manager.startAgent({
      agentId: 'agent-1',
      command: '/bin/bash',
      cwd: '/tmp',
      onExit: onExitSpy,
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('exited')
    })

    expect(onExitSpy).toHaveBeenCalledTimes(1)
    expect(onExitSpy).toHaveBeenCalledWith({ exitCode: 0, runId: run.runId })
  })

  test('preserves the first exit result when PTY exit fires twice with different codes', async () => {
    exitSequences.push([1, 0])
    const manager = createAgentManager()
    const onExitSpy = vi.fn()

    const run = await manager.startAgent({
      agentId: 'agent-2',
      command: '/bin/bash',
      cwd: '/tmp',
      onExit: onExitSpy,
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('error')
    })

    expect(onExitSpy).toHaveBeenCalledTimes(1)
    expect(onExitSpy).toHaveBeenCalledWith({ exitCode: 1, runId: run.runId })
    expect(manager.getRun(run.runId)).toMatchObject({ exitCode: 1, status: 'error' })
  })
})
