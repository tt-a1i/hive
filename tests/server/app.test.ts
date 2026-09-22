import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { CODER_ROLE_DESCRIPTION } from '../../src/server/role-templates.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<{ close: () => void }> = []
const tempDirs: string[] = []
const tinyAvatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
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
        can_run_hive_update: true,
        current_version: '0.6.0-alpha.3',
        install_hint: 'npm install -g @tt-a1i/hive@latest',
        install_source: 'npm-global',
        latest_version: '0.6.0-alpha.4',
        package_name: '@tt-a1i/hive',
        release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
        update_note: 'Hive appears to be installed through npm.',
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
  test('guards against serving newer web assets from an older runtime process', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'hive-static-version-skew-'))
    tempDirs.push(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><p>new app shell</p>')
    const savedStaticDir = process.env.HIVE_STATIC_DIR
    process.env.HIVE_STATIC_DIR = staticDir
    const store = createRuntimeStore({ agentManager: createAgentManager() })
    const app = createApp({
      store,
      packageVersionReader: (() => {
        const versions = ['1.3.4', '1.4.0']
        return () => versions.shift() ?? '1.4.0'
      })(),
    })
    if (savedStaticDir === undefined) delete process.env.HIVE_STATIC_DIR
    else process.env.HIVE_STATIC_DIR = savedStaticDir

    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`

    const shellResponse = await fetch(`${baseUrl}/`)
    expect(shellResponse.status).toBe(409)
    expect(shellResponse.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(shellResponse.text()).resolves.toContain('Restart Hive')

    const apiResponse = await fetch(`${baseUrl}/api/newer-runtime-only`)
    expect(apiResponse.status).toBe(409)
    await expect(apiResponse.json()).resolves.toEqual({
      code: 'runtime_version_mismatch',
      current_version: '1.3.4',
      error: 'Hive was updated on disk. Restart the running hive process to use the new version.',
      installed_version: '1.4.0',
    })
  })

  test('GET /api/version returns cached update metadata for the UI', async () => {
    const { baseUrl } = await startServerWithVersionInfo()

    const response = await fetch(`${baseUrl}/api/version`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      can_run_hive_update: true,
      current_version: '0.6.0-alpha.3',
      install_hint: 'npm install -g @tt-a1i/hive@latest',
      install_source: 'npm-global',
      latest_version: '0.6.0-alpha.4',
      package_name: '@tt-a1i/hive',
      release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
      update_note: 'Hive appears to be installed through npm.',
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
      path: realpathSync.native(workspacePath),
      orchestrator_start: { ok: false, error: null, run_id: null },
    })
  })

  test('POST /api/workspaces accepts quoted paths copied from Windows Explorer', async () => {
    const { baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-quoted-path-'))
    tempDirs.push(workspacePath)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: `  "${workspacePath}"  `,
        name: 'Quoted',
        autostart_orchestrator: false,
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      name: 'Quoted',
      path: realpathSync.native(workspacePath),
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
      avatar: tinyAvatar,
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
        avatar: tinyAvatar,
        name: 'Alice',
        role: 'coder',
        status: 'working',
        pending_task_count: 1,
        last_pty_line: null,
        command_preset_id: null,
        startup_ready_at: null,
        configured_command: null,
        configured_model: null,
        description: CODER_ROLE_DESCRIPTION,
        // #35: open dispatches surface with id + age so the orchestrator can
        // `team cancel` a stale one without guessing ids.
        open_dispatches: [
          {
            id: expect.any(String),
            status: 'queued',
            age_minutes: expect.any(Number),
            task_preview: 'Implement feature',
          },
        ],
      },
    ])
  })

  test('UI roster exposes configured models without leaking private launch arguments', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-roster-resources', 'Resources')
    const worker = store.addWorker(workspace.id, {
      name: 'Custom coder',
      role: 'coder',
      description: 'User selected specialist',
    })
    const cookie = await getUiCookie(baseUrl)
    const config = {
      command: 'codex',
      args: ['--model', 'user-selected-model', '--api-key', 'private-argument'],
    }
    const configured = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(config),
      }
    )
    expect(configured.status).toBe(204)
    const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    // Exact keys reject accidental token, raw args, or env exposure.
    expect(await response.json()).toEqual([
      {
        id: worker.id,
        name: 'Custom coder',
        role: 'coder',
        description: 'User selected specialist',
        status: 'stopped',
        pending_task_count: 0,
        last_pty_line: null,
        command_preset_id: 'codex',
        startup_ready_at: null,
        configured_command: 'codex',
        configured_model: 'user-selected-model',
      },
    ])
    expect(store.peekAgentLaunchConfig(workspace.id, worker.id)?.args).toEqual(config.args)
    expect(store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
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
      last_pty_line: null,
      command_preset_id: null,
      startup_ready_at: null,
      configured_command: null,
      configured_model: null,
      description: CODER_ROLE_DESCRIPTION,
    })
    expect(store.listWorkers(workspace.id)).toEqual([
      {
        id: expect.any(String),
        name: 'Alice',
        role: 'coder',
        description: CODER_ROLE_DESCRIPTION,
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('POST /api/workspaces/:id/workers rejects the retired Sentinel role', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Argus', role: 'sentinel' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid worker role' })
    expect(store.listWorkers(workspace.id)).toEqual([])
  })

  test('worker avatar can be set on create and cleared through PATCH', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const createResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ avatar: tinyAvatar, name: 'Alice', role: 'coder' }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { avatar?: string; id: string }
    expect(created.avatar).toBe(tinyAvatar)

    const clearResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/workers/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ avatar: null }),
      }
    )

    expect(clearResponse.status).toBe(200)
    const cleared = (await clearResponse.json()) as { avatar?: string }
    expect(cleared.avatar).toBeUndefined()
  })

  test('worker avatar rejects non-image data URLs before creating a worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ avatar: 'data:text/plain;base64,SGk=', name: 'Alice', role: 'coder' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Worker avatar must be a PNG, JPEG, or WebP data URL',
    })
    expect(store.listWorkers(workspace.id)).toEqual([])
  })

  test('worker avatar rejects mismatched image payloads before creating a worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ avatar: 'data:image/png;base64,SGk=', name: 'Alice', role: 'coder' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Worker avatar data does not match its image type',
    })
    expect(store.listWorkers(workspace.id)).toEqual([])
  })

  test('worker PATCH validates avatar before renaming', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ avatar: 'data:image/png;base64,SGk=', name: 'Bob' }),
    })

    expect(response.status).toBe(400)
    expect(store.getWorker(workspace.id, worker.id).name).toBe('Alice')
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
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
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
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
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
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
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
