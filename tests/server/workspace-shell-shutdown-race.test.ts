import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createWorkspaceShellRuntime } from '../../src/server/workspace-shell-runtime.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

test('shutdown drains a real shell whose start has not yet returned', async () => {
  const path = mkdtempSync(join(tmpdir(), 'hive-shell-shutdown-race-'))
  const manager = createAgentManager()
  let runId: string | undefined
  let exited = false
  // Observe the actual manager's exit notification; do not substitute the PTY.
  const runtime = createWorkspaceShellRuntime({
    ...manager,
    async startAgent(input) {
      const run = await manager.startAgent({
        ...input,
        onExit(event) {
          exited = true
          input.onExit?.(event)
        },
      })
      runId = run.runId
      return run
    },
  })
  const workspace = { id: randomUUID(), name: 'Shutdown race', path }
  try {
    const starting = runtime.start(workspace)
    const closing = runtime.close()
    const [start, close] = await Promise.allSettled([starting, closing])
    expect(close.status).toBe('fulfilled')
    expect(start.status).toBe('rejected')
    expect(exited).toBe(true)
    expect(runtime.listTerminalRuns(workspace.id)).toEqual([])
    await expect(runtime.start(workspace)).rejects.toBeInstanceOf(Error)
  } finally {
    if (runId && !exited) manager.stopRun(runId)
    if (runId) await expect.poll(() => exited, { timeout: 5000 }).toBe(true)
    await runtime.close()
    removeTestPath(path)
  }
}, 15_000)
