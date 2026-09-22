import { describe, expect, test, vi } from 'vitest'

import {
  AGENT_RUNTIME_CLOSE_TIMEOUT_MS,
  closeAgentRuntime,
} from '../../src/server/agent-runtime-close.js'
import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'
import type { LiveRunRegistry, RunExitEntry } from '../../src/server/live-run-registry.js'

describe('closeAgentRuntime', () => {
  test('does not hang forever when a PTY exit promise never resolves', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = {
      agentId: 'agent-1',
      exitCode: null,
      output: '',
      pid: 4242,
      runId: 'run-1',
      startedAt: 1,
      status: 'running',
    } satisfies LiveAgentRun
    const removed: string[] = []
    const stopped: string[] = []
    const managerRemoved: string[] = []
    const exitEntry: RunExitEntry = {
      promise: new Promise<void>(() => {}),
      resolve: () => {},
      runId: run.runId,
    }
    const registry: LiveRunRegistry = {
      add: () => {},
      clearPendingExitCode: () => {},
      createExitEntry: () => {},
      deleteExitEntry: () => {},
      get: () => undefined,
      getExitEntry: () => undefined,
      getPendingExitCode: () => undefined,
      hasPendingExitCode: () => false,
      list: () => (removed.length === 0 ? [run] : []),
      listExitEntries: () => [exitEntry],
      remove: (runId) => {
        removed.push(runId)
      },
      resolveExit: () => {},
      setPendingExitCode: () => {},
    }

    const closing = closeAgentRuntime(
      {
        removeRun: (runId: string) => {
          managerRemoved.push(runId)
        },
        stopRun: (runId: string) => {
          stopped.push(runId)
        },
        // biome-ignore lint/suspicious/noExplicitAny: closeAgentRuntime only uses stop/remove here.
      } as any,
      registry,
      (value) => value
    )
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_CLOSE_TIMEOUT_MS)
    await closing

    expect(stopped).toEqual(['run-1'])
    expect(managerRemoved).toEqual(['run-1'])
    expect(removed).toEqual(['run-1'])
    expect(consoleError).toHaveBeenCalledWith(
      '[hive] timed out waiting for agent exit during shutdown: run-1'
    )
    vi.useRealTimers()
  })
})
