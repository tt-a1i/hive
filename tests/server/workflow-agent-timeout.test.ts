import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Workflow observation timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Real workflow VM, dispatch executor, native timers, PTY, SQLite and HTTP.
// The passive CLI never contacts a provider; reports enter through the team API.
const withWorkflow = async (
  timeoutMs: number,
  maxDurationMs: number,
  check: (context: {
    server: Awaited<ReturnType<typeof startTestServer>>
    workspaceId: string
    runId: string
    cookie: string
  }) => Promise<void>
) => {
  const server = await startTestServer()
  const originalPath = process.env.PATH
  try {
    prependPassiveWorkflowCliPath(server.dataDir, ['claude'], originalPath)
    const workspacePath = join(server.dataDir, 'ws')
    mkdirSync(workspacePath)
    const workspace = server.store.createWorkspace(workspacePath, 'WS')
    const scriptPath = join(workspacePath, 'timeout.ts')
    writeFileSync(
      scriptPath,
      `export const meta = { name: 'timeout', description: 'timer regression', maxDurationMs: ${maxDurationMs} }\nreturn await agent('wait for report', { timeoutMs: ${timeoutMs} })`
    )
    const cookie = await getUiCookie(server.baseUrl)
    const run = await server.store.startWorkflow({
      workspaceId: workspace.id,
      scriptPath,
      hivePort: new URL(server.baseUrl).port,
    })
    await waitFor(() => server.store.listWorkflowRunDispatches(run.id).length > 0)
    await check({ server, workspaceId: workspace.id, runId: run.id, cookie })
  } finally {
    process.env.PATH = originalPath
    await server.close()
  }
}

test.each([
  2000, 2147483647, 2147483648, 1e15,
])('agent timeout %s waits for a delayed HTTP report', async (timeoutMs) => {
  await withWorkflow(timeoutMs, 10_000, async ({ server, workspaceId, runId }) => {
    // Cross the native overflow-to-1ms boundary before delivering a report.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.store.getWorkflowRun(runId)?.status).toBe('running')
    const dispatch = server.store.listWorkflowRunDispatches(runId)[0]
    if (!dispatch) throw new Error('Expected workflow dispatch')
    expect(dispatch.status).toBe('submitted')
    const response = await fetch(`${server.baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: dispatch.toAgentId,
        token: server.store.peekAgentToken(dispatch.toAgentId),
        dispatch_id: dispatch.id,
        result: 'delayed report',
      }),
    })
    expect(response.status).toBe(202)
    await waitFor(() => server.store.getWorkflowRun(runId)?.status !== 'running')
    expect(server.store.getWorkflowRun(runId)).toMatchObject({
      status: 'completed',
      result: 'delayed report',
    })
    expect(server.store.listWorkers(workspaceId)).toHaveLength(0)
  })
}, 20_000)

test.each([
  'timeout',
  'stop',
  'budget',
] as const)('pending agent timer respects %s and releases its worker', async (mode) => {
  await withWorkflow(
    mode === 'timeout' ? 200 : 2147483648,
    mode === 'budget' ? 3000 : 10_000,
    async ({ server, workspaceId, runId, cookie }) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(server.store.getWorkflowRun(runId)?.status).toBe('running')
      if (mode === 'stop') {
        const response = await fetch(`${server.baseUrl}/api/workflows/runs/${runId}/stop`, {
          method: 'POST',
          headers: { cookie },
        })
        expect(response.status).toBe(202)
      }
      await waitFor(() => server.store.getWorkflowRun(runId)?.status !== 'running')
      expect(server.store.getWorkflowRun(runId)?.status).toBe(
        mode === 'timeout' ? 'failed' : 'stopped'
      )
      expect(server.store.listWorkflowRunDispatches(runId)[0]?.status).toBe('cancelled')
      expect(server.store.listWorkers(workspaceId)).toHaveLength(0)
    }
  )
}, 20_000)
