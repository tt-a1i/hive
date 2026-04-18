import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const servers: Array<{ close: () => void }> = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
})

const startServer = async () => {
  const store = createRuntimeStore()
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

describe('runtime http app', () => {
  test('GET /api/workspaces returns current workspace list', async () => {
    const { store, baseUrl } = await startServer()
    store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const response = await fetch(`${baseUrl}/api/workspaces`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/hive-alpha',
      },
    ])
  })

  test('POST /api/workspaces creates workspace', async () => {
    const { baseUrl } = await startServer()

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/hive-beta', name: 'Beta' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      name: 'Beta',
      path: '/tmp/hive-beta',
    })
  })

  test('GET /api/workspaces/:id/team returns worker team list', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/team`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: worker.id,
        name: 'Alice',
        role: 'coder',
        status: 'working',
        pendingTaskCount: 1,
      },
    ])
  })

  test('POST /api/workspaces/:id/workers creates a worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      workspaceId: workspace.id,
      name: 'Alice',
      role: 'coder',
      status: 'idle',
      pendingTaskCount: 0,
    })
    expect(store.listWorkers(workspace.id)).toEqual([
      {
        id: expect.any(String),
        name: 'Alice',
        role: 'coder',
        status: 'idle',
        pendingTaskCount: 0,
      },
    ])
  })

  test('POST /api/team/send and /api/team/report update worker state', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: workspace.id,
        fromAgentId: 'orch-1',
        to: worker.id,
        text: 'Implement feature',
      }),
    })

    expect(sendResponse.status).toBe(202)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('working')

    const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: workspace.id,
        fromAgentId: worker.id,
        result: 'Done',
        status: 'success',
        artifacts: [],
      }),
    })

    expect(reportResponse.status).toBe(202)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })
})
