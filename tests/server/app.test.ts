import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<{ close: () => void }> = []
const tempDirs: string[] = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const startServer = async () => {
  const store = createRuntimeStore({ agentManager: createAgentManager() })
  const app = createApp({ store })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const startServerWithVersionInfo = async () => {
  const store = createRuntimeStore({ agentManager: createAgentManager() })
  const app = createApp({
    store,
    versionService: {
      getVersionInfo: async () => ({
        current_version: '0.6.0-alpha.3',
        install_hint: 'npm update -g @tt-a1i/hive',
        latest_version: '0.6.0-alpha.4',
        package_name: '@tt-a1i/hive',
        release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
        update_available: true,
      }),
    },
  })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const requestWithHeaders = async (
  baseUrl: string,
  path: string,
  headers: Record<string, string>
) => {
  const target = new URL(path, baseUrl)
  return new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        port: target.port,
        method: 'GET',
        headers,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ body, statusCode: response.statusCode ?? 0 })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

describe('runtime http app', () => {
  test('GET /api/version returns cached update metadata for the UI', async () => {
    const { baseUrl } = await startServerWithVersionInfo()

    const response = await fetch(`${baseUrl}/api/version`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      current_version: '0.6.0-alpha.3',
      install_hint: 'npm update -g @tt-a1i/hive',
      latest_version: '0.6.0-alpha.4',
      package_name: '@tt-a1i/hive',
      release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
      update_available: true,
    })
  })

  test('GET /api/workspaces returns current workspace list', async () => {
    const { store, baseUrl } = await startServer()
    store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/hive-alpha',
      },
    ])
  })

  test('POST /api/workspaces creates workspace (autostart skipped)', async () => {
    const { baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-beta-'))
    tempDirs.push(workspacePath)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: workspacePath,
        name: 'Beta',
        autostart_orchestrator: false,
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      name: 'Beta',
      path: realpathSync(workspacePath),
      orchestrator_start: { ok: false, error: null, run_id: null },
    })
  })

  test('POST /api/workspaces rejects oversized JSON bodies before creating workspace', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: '/tmp/hive-oversized',
        name: 'Oversized',
        notes: 'x'.repeat(1024 * 1024),
      }),
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'Request body too large' })
    expect(store.listWorkspaces()).toEqual([])
  })

  test('GET /api/ui/workspaces/:id/team returns worker team list for the UI', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
    const cookie = sessionResponse.headers.get('set-cookie')
    if (!cookie) {
      throw new Error('Expected UI session cookie')
    }

    const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: worker.id,
        name: 'Alice',
        role: 'coder',
        status: 'working',
        pending_task_count: 1,
        last_output_line: null,
      },
    ])
  })

  test('GET /api/workspaces/:id/team rejects anonymous callers', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/team`)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Missing agent identity' })
  })

  test('GET /api/ui/workspaces/:id/team rejects non-browser requests', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'UI endpoint requires valid UI token',
    })
  })

  test('GET /api/ui/session issues HttpOnly UI cookie', async () => {
    const { baseUrl } = await startServer()

    const response = await fetch(`${baseUrl}/api/ui/session`)

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
    await expect(response.json()).resolves.toEqual({
      ok: true,
    })
  })

  test('rejects non-local Host and Origin headers before issuing a UI token', async () => {
    const { baseUrl } = await startServer()

    const hostResponse = await requestWithHeaders(baseUrl, '/api/ui/session', {
      Host: 'attacker.example',
    })
    expect(hostResponse.statusCode).toBe(403)
    expect(JSON.parse(hostResponse.body)).toEqual({
      error: 'Local runtime rejected non-local Host header',
    })

    const originResponse = await requestWithHeaders(baseUrl, '/api/ui/session', {
      Origin: 'https://attacker.example',
    })
    expect(originResponse.statusCode).toBe(403)
    expect(JSON.parse(originResponse.body)).toEqual({
      error: 'Local runtime rejected non-local Origin header',
    })
  })

  test('POST /api/workspaces/:id/workers creates a worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      agent_start: { ok: false, error: null, run_id: null },
      id: expect.any(String),
      name: 'Alice',
      role: 'coder',
      status: 'stopped',
      pending_task_count: 0,
      last_output_line: null,
    })
    expect(store.listWorkers(workspace.id)).toEqual([
      {
        id: expect.any(String),
        name: 'Alice',
        role: 'coder',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('DELETE /api/workspaces/:id/workers/:workerId stops active run and removes worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    const configResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          command: '/bin/bash',
          args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
        }),
      }
    )
    expect(configResponse.status).toBe(204)

    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: '4010' }),
      }
    )
    expect(startResponse.status).toBe(201)
    expect(store.listTerminalRuns(workspace.id).some((run) => run.agent_id === worker.id)).toBe(
      true
    )

    const deleteResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    )

    expect(deleteResponse.status).toBe(204)
    expect(store.listWorkers(workspace.id)).toEqual([])
    expect(store.listTerminalRuns(workspace.id).some((run) => run.agent_id === worker.id)).toBe(
      false
    )
    expect(store.peekAgentLaunchConfig(workspace.id, worker.id)).toBeUndefined()
  })

  test('POST /api/team/send and /api/team/report update worker state', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.recordUserInput(workspace.id, orchestrator.id, 'bootstrap')

    const workerStartResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          command: '/bin/bash',
          args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
        }),
      }
    )
    expect(workerStartResponse.status).toBe(204)

    const orchConfigResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestrator.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          command: '/bin/bash',
          args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
        }),
      }
    )
    expect(orchConfigResponse.status).toBe(204)

    const workerRunStart = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: '4010' }),
      }
    )
    if (workerRunStart.status !== 201) {
      throw new Error(`worker start failed: ${await workerRunStart.text()}`)
    }
    expect(workerRunStart.status).toBe(201)

    const orchRunStart = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestrator.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: '4010' }),
      }
    )
    expect(orchRunStart.status).toBe(201)

    const orchestratorToken = store.peekAgentToken(orchestrator.id)
    const workerToken = store.peekAgentToken(worker.id)

    const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token: orchestratorToken,
        to: 'Alice',
        text: 'Implement feature',
      }),
    })

    expect(sendResponse.status).toBe(202)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('working')

    const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: workerToken,
        result: 'Done',
        status: 'success',
        artifacts: [],
      }),
    })

    expect(reportResponse.status).toBe(202)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })

  test('POST /api/workspaces/:id/workers rejects duplicate worker names in one workspace', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', role: 'tester' }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Worker name already exists: Alice',
    })
  })
})
