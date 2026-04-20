import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

interface HiveContext {
  baseUrl: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  orchestratorId: string
  worker: { id: string; name: string }
  workspaceId: string
}

const setupHive = async (): Promise<HiveContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-authz-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
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
        command: '/bin/bash',
        args: ['-lc', `"${process.execPath}" "${passiveScript}"`],
      }),
    })
    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ hive_port: String(hive.port) }),
    })
  }

  return {
    baseUrl,
    hive,
    orchestratorId,
    worker,
    workspaceId: workspace.id,
  }
}

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team API authz (R1.4)', () => {
  test('rejects spoofed orchestrator id without a valid token (401)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: 'totally-wrong-token',
          to: 'Alice',
          text: 'hack',
        }),
      })
      expect(response.status).toBe(401)
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.filter((item) => item.type === 'send')).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects worker that invokes /api/team/send (403)', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          to: 'Alice',
          text: 'self-dispatch attempt',
        }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('coder') })
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.filter((item) => item.type === 'send')).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects anonymous caller that invokes CLI team list endpoint (401)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Missing agent identity' })
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects caller without UI cookie for UI team endpoint (403)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/ui/workspaces/${ctx.workspaceId}/team`)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'UI endpoint requires valid UI token' })
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects worker that invokes CLI team list endpoint (403)', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`, {
        method: 'GET',
        headers: {
          'x-hive-agent-id': ctx.worker.id,
          'x-hive-agent-token': workerToken,
        },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('coder') })
    } finally {
      await ctx.hive.close()
    }
  })

  test('orchestrator can invoke CLI team list endpoint (200)', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`, {
        method: 'GET',
        headers: {
          'x-hive-agent-id': ctx.orchestratorId,
          'x-hive-agent-token': orchToken,
        },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual([
        {
          id: ctx.worker.id,
          name: 'Alice',
          pending_task_count: 0,
          role: 'coder',
          status: 'idle',
        },
      ])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects token from workspace A used against workspace B (401)', async () => {
    const ctxA = await setupHive()
    try {
      const tokenA = ctxA.hive.store.peekAgentToken(ctxA.orchestratorId)
      if (!tokenA) {
        throw new Error('Expected orchestrator token after start')
      }
      // Forged request: orchestrator id from workspace A, projectId of a different workspace
      // that exists alongside. Create a second workspace via the same runtime.
      const secondResponse = await fetch(`${ctxA.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await getUiCookie(ctxA.baseUrl),
        },
        body: JSON.stringify({ name: 'Beta', path: '/tmp/hive-authz-beta' }),
      })
      const secondWorkspace = (await secondResponse.json()) as { id: string }

      const response = await fetch(`${ctxA.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: secondWorkspace.id,
          from_agent_id: ctxA.orchestratorId,
          token: tokenA,
          to: 'Alice',
          text: 'cross-workspace dispatch attempt',
        }),
      })
      expect(response.status).toBe(401)
    } finally {
      await ctxA.hive.close()
    }
  })

  test('worker reporting with its own token succeeds (202) and decrements pending count', async () => {
    const ctx = await setupHive()
    try {
      // Bump pending so we can verify decrement.
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'task A',
        }),
      })
      expect(ctx.hive.store.getWorker(ctx.workspaceId, ctx.worker.id).pendingTaskCount).toBe(1)

      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          result: 'done',
          status: 'success',
          artifacts: [],
        }),
      })
      expect(response.status).toBe(202)
      expect(ctx.hive.store.getWorker(ctx.workspaceId, ctx.worker.id).pendingTaskCount).toBe(0)
    } finally {
      await ctx.hive.close()
    }
  })

  test('orchestrator with valid token succeeds (202) and records send', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'Implement login',
        }),
      })
      expect(response.status).toBe(202)
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.some((item) => item.type === 'send' && item.text === 'Implement login')).toBe(
        true
      )
    } finally {
      await ctx.hive.close()
    }
  })
})
