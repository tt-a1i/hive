import { afterEach, describe, expect, test, vi } from 'vitest'

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
    let exitHandler: ((event: { exitCode: number }) => void) | undefined

    queueMicrotask(() => {
      exitHandler?.({ exitCode: 0 })
      exitHandler?.({ exitCode: 0 })
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
  vi.clearAllMocks()
})

describe('agent manager finishRun', () => {
  test('invokes onExit only once when PTY exit fires twice', async () => {
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
})
