import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  delete process.env.HIVE_DATA_DIR
  for (const d of tempDirs.splice(0)) removeTestPath(d)
})

const waitFor = async <T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timeout')
}

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'team-wf-show-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  tempDirs.push(dataDir)
  prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
  writeFileSync(
    join(workspacePath, '.hive/workflows/noop.ts'),
    "export const meta = { name: 'noop', description: 'd' }\nreturn 'from-noop'"
  )

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  // Workflows are an experimental opt-in (off by default); enable so the
  // `team workflow run/show` happy path under test is reachable.
  await fetch(`${baseUrl}/api/settings/workflow-feature`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ enabled: true }),
  })

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({
      command: process.execPath,
      args: [passiveScript],
    }),
  })
  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ hive_port: String(hive.port) }),
  })

  return { baseUrl, dataDir, hive, orchestratorId, workspaceId: workspace.id, workspacePath }
}

describe('team workflow show (TIER 1 #6)', () => {
  test('returns the run record and per-dispatch detail for a completed inline workflow', async () => {
    /* Regression for TIER 1 #6: the workflow completion reminder
       advertises `team workflow show <run-id>` as the escape hatch for
       full per-agent transcripts (the reminder itself truncates each
       agent's reportText to 200 chars). Before this fix the command
       was a no-op — orchestrators that followed the suggestion got a
       usage error. */
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const prompt = 'Full prompt body that must survive workflow show'
      const reportText = `full-report-start ${'x'.repeat(420)} full-report-end`
      const runResp = await fetch(`${ctx.baseUrl}/api/team/workflow/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          source: [
            "export const meta = { name: 'detail', description: 'd' }",
            "phase('Audit')",
            `const answer = await agent(${JSON.stringify(prompt)}, { label: 'audit-one' })`,
            'return answer',
          ].join('\n'),
        }),
      })
      expect(runResp.status).toBe(202)
      const runBody = (await runResp.json()) as { run_id: string }

      // Starting a real CLI and delivering its startup prompt precede dispatch creation.
      const workerRun = await waitFor(() => {
        const worker = ctx.hive.store.listWorkers(ctx.workspaceId)[0]
        return worker ? ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, worker.id) : undefined
      })
      await workerRun.postStartInputReady
      expect(workerRun.startupReadyAt).toEqual(expect.any(Number))

      const dispatch = await waitFor(() =>
        ctx.hive.store
          .listDispatches(ctx.workspaceId, { status: 'submitted' })
          .find((item) => item.workflowRunId === runBody.run_id)
      )
      await waitFor(() => {
        const delivered = ctx.hive.store
          .listDispatches(ctx.workspaceId)
          .find((item) => item.id === dispatch.id)
        const output = ctx.hive.store.getActiveRunByAgentId(
          ctx.workspaceId,
          dispatch.toAgentId
        )?.output
        return delivered?.deliveredAt && output?.includes(`DISPATCH:${dispatch.id}`)
          ? true
          : undefined
      })
      const workerToken = ctx.hive.store.peekAgentToken(dispatch.toAgentId)
      if (!workerToken) throw new Error('Expected workflow worker token')
      const reportResp = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: dispatch.toAgentId,
          token: workerToken,
          dispatch_id: dispatch.id,
          result: reportText,
        }),
      })
      expect(reportResp.status).toBe(202)

      const final = await waitFor(() => {
        const run = ctx.hive.store.getWorkflowRun(runBody.run_id)
        return run && run.status !== 'running' ? run : undefined
      })
      expect(final?.status).toBe('completed')

      const showResp = await fetch(`${ctx.baseUrl}/api/team/workflow/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          run_id: runBody.run_id,
        }),
      })
      expect(showResp.status).toBe(200)
      const payload = (await showResp.json()) as {
        ok: boolean
        run: { id: string; status: string; result: unknown; name: string }
        dispatches: Array<{
          label: string | null
          phase: string | null
          report_text: string | null
          status: string
          step_index: number | null
          text: string
          to_agent_id: string
        }>
      }
      expect(payload.ok).toBe(true)
      expect(payload.run.id).toBe(runBody.run_id)
      expect(payload.run.status).toBe('completed')
      expect(payload.run.result).toBe(reportText)
      expect(payload.dispatches).toHaveLength(1)
      expect(payload.dispatches[0]).toEqual(
        expect.objectContaining({
          label: 'audit-one',
          phase: 'Audit',
          report_text: reportText,
          status: 'reported',
          step_index: 1,
          text: prompt,
          to_agent_id: dispatch.toAgentId,
        })
      )
    } finally {
      await ctx.hive.close()
    }
  })

  test('returns 404 for a run that does not exist (or belongs to another workspace)', async () => {
    /* Cross-workspace + missing-id both hit the same 404 path — the
       workspace check (run.workspaceId !== projectId) is the
       authorization boundary, and conflating it with "not found"
       avoids leaking the existence of foreign runs to the orchestrator. */
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')
      const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          run_id: 'does-not-exist',
        }),
      })
      expect(resp.status).toBe(404)
    } finally {
      await ctx.hive.close()
    }
  })

  test('workflow stop returns 404 for a run that belongs to another workspace', async () => {
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const foreignPath = join(ctx.dataDir, 'other-ws')
      mkdirSync(foreignPath, { recursive: true })
      const foreignScript = join(foreignPath, 'foreign.ts')
      writeFileSync(
        foreignScript,
        ["export const meta = { name: 'foreign', description: 'd' }", 'return 1'].join('\n')
      )
      const foreignWs = ctx.hive.store.createWorkspace(foreignPath, 'Other WS')
      const foreignRun = await ctx.hive.store.runWorkflow({
        workspaceId: foreignWs.id,
        scriptPath: foreignScript,
        hivePort: '0',
      })

      const stopResp = await fetch(`${ctx.baseUrl}/api/team/workflow/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          run_id: foreignRun.id,
        }),
      })

      expect(stopResp.status).toBe(404)
      expect(ctx.hive.store.getWorkflowRun(foreignRun.id)?.status).toBe('completed')
    } finally {
      await ctx.hive.close()
    }
  })
})
