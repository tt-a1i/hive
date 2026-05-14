import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { getOrchestratorId } from '../../src/server/workspace-store-support.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

const createWorkspace = async (baseUrl: string, cookie: string, path: string, name: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name, path }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; name: string; path: string }
}

const createWorker = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; name: string }
}

const configureAndStartAgent = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string,
  scriptPath: string
) => {
  const configResponse = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: process.execPath, args: [scriptPath] }),
    }
  )
  expect(configResponse.status).toBe(204)

  const startResponse = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
    }
  )
  expect(startResponse.status).toBe(201)
  const payload = (await startResponse.json()) as { run_id: string }
  return { runId: payload.run_id }
}

describe('workspace delete API', () => {
  test('DELETE /api/workspaces/:id stops active agents and removes workspace records only from Hive', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspacePath = join(server.dataDir, 'project')
      mkdirSync(workspacePath, { recursive: true })
      const scriptPath = join(workspacePath, 'agent.js')
      writeFileSync(scriptPath, 'process.stdin.resume();\n')

      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath, 'Alpha')
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      const orchestratorId = getOrchestratorId(workspace.id)
      const orchestratorRun = await configureAndStartAgent(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId,
        scriptPath
      )
      const workerRun = await configureAndStartAgent(
        server.baseUrl,
        cookie,
        workspace.id,
        worker.id,
        scriptPath
      )
      server.store.recordUserInput(workspace.id, orchestratorId, 'delete me')
      await server.store.dispatchTask(workspace.id, worker.id, 'queued work')
      server.store.settings.setAppState('active_workspace_id', workspace.id)

      const db = new Database(join(server.dataDir, 'runtime.sqlite'))
      db.prepare(
        'INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
      ).run(worker.id, workspace.id, 'session-1', Date.now())
      db.close()

      const deleteResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
        headers: { cookie },
      })

      expect(deleteResponse.status).toBe(204)

      await waitFor(async () => {
        const orchestratorState = await fetch(
          `${server.baseUrl}/api/runtime/runs/${orchestratorRun.runId}`,
          { headers: { cookie } }
        ).then((response) => response.json() as Promise<{ status: string }>)
        const workerState = await fetch(`${server.baseUrl}/api/runtime/runs/${workerRun.runId}`, {
          headers: { cookie },
        }).then((response) => response.json() as Promise<{ status: string }>)
        expect(orchestratorState.status).toBe('exited')
        expect(workerState.status).toBe('exited')
      })

      const listResponse = await fetch(`${server.baseUrl}/api/workspaces`, { headers: { cookie } })
      await expect(listResponse.json()).resolves.toEqual([])
      await expect(
        fetch(`${server.baseUrl}/api/settings/app-state/active_workspace_id`, {
          headers: { cookie },
        }).then((response) => response.json())
      ).resolves.toEqual({ key: 'active_workspace_id', value: null })

      const verifyDb = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
      expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 0,
      })
      expect(
        verifyDb
          .prepare('SELECT COUNT(*) AS count FROM workers WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ count: 0 })
      expect(
        verifyDb
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ count: 0 })
      expect(
        verifyDb
          .prepare('SELECT COUNT(*) AS count FROM agent_launch_configs WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ count: 0 })
      expect(
        verifyDb
          .prepare('SELECT COUNT(*) AS count FROM agent_sessions WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ count: 0 })
      expect(
        verifyDb
          .prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id IN (?, ?)')
          .get(orchestratorId, worker.id)
      ).toEqual({ count: 0 })
      verifyDb.close()
    } finally {
      await server.close()
    }
  })
})
