import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentRunRecord } from '../../src/server/agent-manager.js'
import { finishAgentRun } from '../../src/server/agent-manager-support.js'
import type { PtyOutputBus } from '../../src/server/pty-output-bus.js'

const exitSequences: Array<Array<number | null>> = []

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

vi.mock('../../src/server/pty.js', () => ({
  spawn: () => {
    const exitCodes = exitSequences.shift() ?? [0, 0]
    let exitHandler: ((event: { exitCode: number | null }) => void) | undefined

    queueMicrotask(() => {
      for (const exitCode of exitCodes) {
        exitHandler?.({ exitCode })
      }
    })

    return {
      pid: 4242,
      kill() {},
      onData() {},
      onExit(handler: (event: { exitCode: number | null }) => void) {
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
      command: process.execPath,
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
      command: process.execPath,
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

  test('treats a null exit result as terminal when PTY exit fires twice', async () => {
    exitSequences.push([null, 0])
    const manager = createAgentManager()
    const onExitSpy = vi.fn()

    const run = await manager.startAgent({
      agentId: 'agent-3',
      command: process.execPath,
      cwd: '/tmp',
      onExit: onExitSpy,
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('error')
    })

    expect(onExitSpy).toHaveBeenCalledTimes(1)
    expect(onExitSpy).toHaveBeenCalledWith({ exitCode: null, runId: run.runId })
    expect(manager.getRun(run.runId)).toMatchObject({ exitCode: null, status: 'error' })
  })

  test('clears the PTY output bus even when an onExit hook throws', () => {
    const clear = vi.fn()
    const run: AgentRunRecord = {
      agentId: 'agent-4',
      exitCode: null,
      output: 'buffered output',
      pid: 4242,
      process: {
        isStopped: () => false,
        pause() {},
        pid: 4242,
        resize() {},
        resume() {},
        stop() {},
        write() {},
      },
      runId: 'run-4',
      status: 'running',
      onExit: () => {
        throw new Error('store failed')
      },
    }
    const bus: PtyOutputBus = {
      clear,
      publish: vi.fn(),
      subscribe: vi.fn(),
    }

    expect(() => finishAgentRun(run, 0, bus)).toThrow('store failed')
    expect(clear).toHaveBeenCalledWith('run-4')
    expect(run.status).toBe('exited')
  })
})
