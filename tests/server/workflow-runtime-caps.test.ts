import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-caps-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const replyToWorkflowDispatches = (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  text: string
) => {
  let stopped = false
  const finished = (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 20))
      if (stopped) return
      const submitted = store
        .listDispatches(workspaceId, { status: 'submitted' })
        .filter((d) => d.workflowRunId !== null)
      for (const d of submitted) {
        store.reportTask(workspaceId, d.toAgentId, { text, dispatchId: d.id })
      }
    }
  })()
  return {
    finished,
    async stop() {
      stopped = true
      await finished
    },
  }
}

describe('workflow runtime caps (TIER 2 #2 + #11)', () => {
  test('maxAgentCalls (default 1000, overridable via meta) rejects the over-cap agent() call', async () => {
    /* Regression for TIER 2 #11: a runaway `while(true) await agent()`
       would otherwise spawn unbounded PTY subprocesses. The cap fires
       BEFORE the worker is spawned (so no leak), and the rejection
       propagates up into a 'failed' run with a descriptive error. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'over-cap.ts')
    writeFileSync(
      scriptPath,
      [
        // 3-call cap, script tries 4. The 4th must reject; the run
        // surfaces as 'failed' with the cap-named error message.
        "export const meta = { name: 'over-cap', description: 'd', maxAgentCalls: 3 }",
        "await agent('one')",
        "await agent('two')",
        "await agent('three')",
        "await agent('four — should reject')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const replies = replyToWorkflowDispatches(store, ws.id, 'ok')
      try {
        const run = await Promise.race([
          store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' }),
          replies.finished.then(() => {
            throw new Error('Report loop ended before workflow completion')
          }),
        ])
        expect(run.status).toBe('failed')
        expect(run.error).toMatch(/Workflow agent cap exceeded: 3/)
      } finally {
        await replies.stop()
      }
    } finally {
      await store.close()
    }
  })

  test('maxDurationMs triggers a stop on expiry; run records status=stopped (TIER 2 #11)', async () => {
    /* Hard wall-clock cap. The timer routes through the same path as
       a user stop, so existing 'stopped' semantics apply uniformly —
       in-flight awaiters reject, the outer catch records status=stopped. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'too-slow.ts')
    writeFileSync(
      scriptPath,
      [
        // 200ms budget, single agent() that never reports → budget fires
        // and the run flips to 'stopped' well before the awaiter's own
        // DEFAULT_TIMEOUT_MS=10min would.
        "export const meta = { name: 'too-slow', description: 'd', maxDurationMs: 200 }",
        "await agent('never reports')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const startedAt = Date.now()
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      const elapsed = Date.now() - startedAt
      expect(run.status).toBe('stopped')
      // The whole point: must terminate WELL inside the 10min awaiter
      // timeout. A few seconds of slack covers PTY startup + cleanup.
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await store.close()
    }
  }, 20_000)

  test('a huge maxDurationMs does not stop the run early (setTimeout 32-bit clamp)', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'long.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'long', description: 'd', maxDurationMs: 2147483648 }",
        'const end = Date.now() + 80',
        'while (Date.now() < end) {}',
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const startedAt = Date.now()
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('completed')
      expect(run.result).toBe(1)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80)
    } finally {
      await store.close()
    }
  }, 20_000)

  test('maxDurationMs terminates a CPU-bound workflow script without blocking the runtime', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'spin.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'spin', description: 'd', maxDurationMs: 200 }",
        'while (true) {}',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const startedAt = Date.now()
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(Date.now() - startedAt).toBeLessThan(5000)
      expect(run.status).toBe('stopped')
      expect(run.error).toMatch(/stopped/i)
    } finally {
      await store.close()
    }
  }, 20_000)
})
