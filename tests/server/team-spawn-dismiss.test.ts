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

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  throw lastError
}

interface HiveContext {
  baseUrl: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  orchestratorId: string
  worker: { id: string; name: string }
  workspaceId: string
}

const setupHive = async (): Promise<HiveContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-spawn-dismiss-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
  prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerResponse.json()) as { id: string; name: string }

  for (const agentId of [orchestratorId, worker.id]) {
    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        command: process.execPath,
        args: [passiveScript],
      }),
    })
    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ hive_port: String(hive.port) }),
    })
  }

  return { baseUrl, hive, orchestratorId, worker, workspaceId: workspace.id }
}

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  delete process.env.HIVE_FAKE_CLI_FIRST_PASTE_ACK_DELAY_MS
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('team spawn / dismiss', () => {
  test('orchestrator spawns a PERSISTENT worker by default (M11), then dismisses it', async () => {
    process.env.HIVE_FAKE_CLI_FIRST_PASTE_ACK_DELAY_MS = '1200'
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      const spawnResponse = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'reviewer',
          name: 'verify-1',
          cli: 'claude',
        }),
      })
      expect(spawnResponse.status).toBe(201)
      const spawned = (await spawnResponse.json()) as {
        ok: boolean
        worker_id: string
        ephemeral: boolean
      }
      expect(spawned.ok).toBe(true)
      expect(spawned.ephemeral).toBe(false)

      const created = ctx.hive.store.getWorker(ctx.workspaceId, spawned.worker_id)
      expect(created.name).toBe('verify-1')
      expect(created.role).toBe('reviewer')
      // M11 — default is persistent, not ephemeral.
      expect(created.ephemeral).toBe(false)
      expect(created.spawnedBy).toBe('orchestrator')
      // It must carry a launch config so a later `team send` can wake it.
      expect(ctx.hive.store.peekAgentLaunchConfig(ctx.workspaceId, spawned.worker_id)).toBeTruthy()

      const firstSend = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'verify-1',
          text: 'review first pass',
        }),
      })
      expect(firstSend.status).toBe(202)
      const firstDispatch = (await firstSend.json()) as {
        dispatch_id: string
        queued?: boolean
        restarted_worker?: boolean
      }
      expect(firstDispatch.queued).toBeUndefined()
      expect(firstDispatch.restarted_worker).toBe(true)
      await waitFor(() => {
        const run = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
        const output = run?.output ?? ''
        const firstSubmitIndex = output.indexOf('SUBMITTED')
        const dispatchIndex = output.indexOf(`DISPATCH:${firstDispatch.dispatch_id}`)
        expect(firstSubmitIndex).toBeGreaterThanOrEqual(0)
        expect(dispatchIndex).toBeGreaterThan(firstSubmitIndex)
        expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      }, 8000)
      ctx.hive.store.reportTask(ctx.workspaceId, spawned.worker_id, {
        text: 'reviewed',
        dispatchId: firstDispatch.dispatch_id,
      })

      const activeRun = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
      if (!activeRun) throw new Error('Expected active spawned worker run')
      ctx.hive.store.stopAgentRun(activeRun.runId)
      await waitFor(() => {
        expect(ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)).toBe(
          undefined
        )
      })

      const secondSend = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'verify-1',
          text: 'review after manual stop',
        }),
      })
      expect(secondSend.status).toBe(202)
      const secondDispatch = (await secondSend.json()) as {
        dispatch_id: string
        queued?: boolean
        restarted_worker?: boolean
        worker_status?: string
      }
      expect(secondDispatch.queued).toBe(true)
      expect(secondDispatch.restarted_worker).toBe(false)
      expect(secondDispatch.worker_status).toBe('stopped')
      await ctx.hive.store.cancelTask(ctx.workspaceId, secondDispatch.dispatch_id, {
        fromAgentId: ctx.orchestratorId,
        reason: 'test cleanup',
      })

      const dismissResponse = await fetch(`${ctx.baseUrl}/api/team/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          name: 'verify-1',
        }),
      })
      expect(dismissResponse.status).toBe(200)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).some((w) => w.name === 'verify-1')).toBe(
        false
      )
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('--ephemeral spawns a one-shot worker that auto-dismisses after its first report (M11)', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      const spawnResponse = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'reviewer',
          name: 'one-shot',
          ephemeral: true,
        }),
      })
      expect(spawnResponse.status).toBe(201)
      const spawned = (await spawnResponse.json()) as {
        worker_id: string
        ephemeral: boolean
      }
      expect(spawned.ephemeral).toBe(true)
      const created = ctx.hive.store.getWorker(ctx.workspaceId, spawned.worker_id)
      expect(created.ephemeral).toBe(true)
      expect(created.spawnedBy).toBe('orchestrator')

      // Dispatch from orchestrator + simulate worker's `team report`.
      const dispatch = await ctx.hive.store.dispatchTaskByWorkerName(
        ctx.workspaceId,
        'one-shot',
        'review this',
        { fromAgentId: ctx.orchestratorId, hivePort: '0' }
      )
      await waitFor(() => {
        const run = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
        expect(run?.output).toContain(`DISPATCH:${dispatch.id}`)
        expect(run?.output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      }, 8000)
      ctx.hive.store.reportTask(ctx.workspaceId, spawned.worker_id, {
        text: 'done',
        dispatchId: dispatch.id,
      })

      // queueMicrotask runs after the report path returns. Wait one tick.
      await new Promise((r) => setTimeout(r, 50))

      // Worker should be gone.
      const stillThere = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .some((w) => w.id === spawned.worker_id)
      expect(stillThere).toBe(false)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('ephemeral worker with multiple open dispatches survives until the LAST one is reported', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      const spawnResponse = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'coder',
          name: 'stacked',
          ephemeral: true,
        }),
      })
      expect(spawnResponse.status).toBe(201)
      const spawned = (await spawnResponse.json()) as { worker_id: string }
      const first = await ctx.hive.store.dispatchTaskByWorkerName(
        ctx.workspaceId,
        'stacked',
        'task one',
        { fromAgentId: ctx.orchestratorId, hivePort: '0' }
      )
      const started = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
      expect(started).toBeDefined()
      await started?.postStartInputReady
      expect(started?.startupReadyAt).toEqual(expect.any(Number))
      const second = await ctx.hive.store.dispatchTaskByWorkerName(
        ctx.workspaceId,
        'stacked',
        'task two',
        { fromAgentId: ctx.orchestratorId, hivePort: '0' }
      )
      await waitFor(() => {
        const run = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
        for (const dispatch of [first, second]) {
          expect(run?.output).toContain(`DISPATCH:${dispatch.id}`)
          expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toContainEqual(
            expect.objectContaining({
              id: dispatch.id,
              status: 'submitted',
              deliveredAt: expect.any(Number),
            })
          )
        }
      }, 8000)

      // Reporting the FIRST dispatch must NOT dismiss the worker — the second
      // dispatch is still open and would otherwise be deleted un-reported.
      ctx.hive.store.reportTask(ctx.workspaceId, spawned.worker_id, {
        text: 'one done',
        dispatchId: first.id,
      })
      // Allow the report's queued auto-dismiss callback to run.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(
        ctx.hive.store.listWorkers(ctx.workspaceId).some((w) => w.id === spawned.worker_id)
      ).toBe(true)
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toContainEqual(
        expect.objectContaining({ id: first.id, status: 'reported' })
      )
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toContainEqual(
        expect.objectContaining({ id: second.id, status: 'submitted' })
      )

      // Reporting the LAST open dispatch triggers the auto-dismiss.
      ctx.hive.store.reportTask(ctx.workspaceId, spawned.worker_id, {
        text: 'two done',
        dispatchId: second.id,
      })
      await waitFor(() => {
        expect(
          ctx.hive.store.listWorkers(ctx.workspaceId).some((w) => w.id === spawned.worker_id)
        ).toBe(false)
      })
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('spawn without --name is addressable by its role label, even for unknown roles', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      // The landing-page flow: `team spawn researcher` then `team send researcher`.
      const spawnResponse = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'researcher',
          cli: 'claude',
        }),
      })
      expect(spawnResponse.status).toBe(201)
      const spawned = (await spawnResponse.json()) as { name: string; worker_id: string }
      expect(spawned.name).toBe('researcher')
      const created = ctx.hive.store.getWorker(ctx.workspaceId, spawned.worker_id)
      // Unknown role labels become 'custom', not a silent 'coder'.
      expect(created.role).toBe('custom')
      expect(created.description).toContain('researcher')

      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'researcher',
          text: 'find prior art',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const dispatched = (await sendResponse.json()) as {
        ok: boolean
        dispatch_id: string
        queued?: boolean
        restarted_worker?: boolean
      }
      expect(dispatched.ok).toBe(true)
      expect(dispatched.dispatch_id).toBeTruthy()
      expect(dispatched.queued).toBeUndefined()
      expect(dispatched.restarted_worker).toBe(true)
      await waitFor(() => {
        const run = ctx.hive.store.getActiveRunByAgentId(ctx.workspaceId, spawned.worker_id)
        expect(run?.output).toContain(`DISPATCH:${dispatched.dispatch_id}`)
        expect(run?.output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      }, 8000)

      // A second no-name spawn of the same role must not steal the name.
      const secondSpawn = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'researcher',
          cli: 'claude',
        }),
      })
      expect(secondSpawn.status).toBe(201)
      const second = (await secondSpawn.json()) as { name: string }
      expect(second.name).toMatch(/^researcher-/)
      expect(second.name).not.toBe('researcher')
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('orchestrator cannot respawn the retired Sentinel role', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      const response = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          role: 'sentinel',
          name: 'argus',
          cli: 'claude',
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: "Role 'sentinel' was removed; use coder, reviewer, tester, or custom.",
      })
      expect(
        ctx.hive.store.listWorkers(ctx.workspaceId).some((worker) => worker.name === 'argus')
      ).toBe(false)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('a worker (non-orchestrator) is forbidden from spawning (403)', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) throw new Error('Expected worker token after start')

      const response = await fetch(`${ctx.baseUrl}/api/team/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          role: 'tester',
          name: 'should-not-exist',
        }),
      })
      expect(response.status).toBe(403)
      expect(
        ctx.hive.store.listWorkers(ctx.workspaceId).some((w) => w.name === 'should-not-exist')
      ).toBe(false)
    } finally {
      await ctx.hive.close()
    }
  })
})
