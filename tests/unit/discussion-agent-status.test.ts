import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, test } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const createFakeAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunSnapshot>()
  const onExits = new Map<string, (event: { runId: string; exitCode: number | null }) => void>()

  return {
    getOutputBus() {
      return outputBus
    },
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) throw new Error(`Run not found: ${runId}`)
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const run = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1,
        runId: `run-${input.agentId}`,
        status: 'running' as const,
      }
      runs.set(run.runId, run)
      if (input.onExit) onExits.set(run.runId, input.onExit)
      return run
    },
    stopRun(runId) {
      const run = runs.get(runId)
      if (!run || run.status === 'exited') return
      run.status = 'exited'
      run.exitCode = 0
      onExits.get(runId)?.({ runId, exitCode: 0 })
    },
    writeInput() {},
  }
}

const servers: Array<{ close: () => void }> = []
const stores: RuntimeStore[] = []

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  for (const store of stores.splice(0)) await store.close()
})

const startServer = async () => {
  const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
  const app = createApp({ store })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)
  stores.push(store)

  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind')

  return { baseUrl: `http://127.0.0.1:${address.port}`, store }
}

const postJson = async (baseUrl: string, path: string, body: unknown, cookie: string) => {
  const target = new URL(path, baseUrl)
  const payload = JSON.stringify(body)

  return new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        path: target.pathname,
        port: target.port,
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(payload).toString(),
          'content-type': 'application/json',
          cookie,
        },
      },
      (response) => {
        let bodyText = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          bodyText += chunk
        })
        response.on('end', () => {
          resolve({ body: bodyText, statusCode: response.statusCode ?? 0 })
        })
      }
    )
    request.on('error', reject)
    request.end(payload)
  })
}

describe('discussion participant agent status', () => {
  test('active discussion members appear working in team list until skip or end', async () => {
    const { baseUrl, store } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-discussion-status', 'Discussion Status')
    const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

    store.configureAgentLaunch(workspace.id, alice.id, { command: '/bin/bash', args: [] })
    store.configureAgentLaunch(workspace.id, bob.id, { command: '/bin/bash', args: [] })
    await store.startAgent(workspace.id, alice.id, { hivePort: '4010' })
    await store.startAgent(workspace.id, bob.id, { hivePort: '4010' })
    expect(store.listWorkers(workspace.id).map((w) => [w.name, w.status])).toEqual([
      ['Alice', 'idle'],
      ['Bob', 'idle'],
    ])

    const cookie = await getUiCookie(baseUrl)
    const startResponse = await postJson(
      baseUrl,
      '/api/team/discuss/start',
      {
        members: ['Alice', 'Bob'],
        project_id: workspace.id,
        topic: 'status test',
      },
      cookie
    )
    expect(startResponse.statusCode).toBe(201)

    expect(store.listWorkers(workspace.id).map((w) => [w.name, w.status])).toEqual([
      ['Alice', 'working'],
      ['Bob', 'working'],
    ])

    const skipResponse = await postJson(
      baseUrl,
      '/api/team/discuss/skip',
      {
        project_id: workspace.id,
        worker_name: 'Alice',
      },
      cookie
    )
    expect(skipResponse.statusCode).toBe(200)

    expect(store.listWorkers(workspace.id).map((w) => [w.name, w.status])).toEqual([
      ['Alice', 'idle'],
      ['Bob', 'idle'],
    ])
  })

  test('discussion participant stays working after reporting the last pending dispatch', async () => {
    const { baseUrl, store } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-discussion-report-status', 'Report Status')
    const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

    store.configureAgentLaunch(workspace.id, alice.id, { command: '/bin/bash', args: [] })
    store.configureAgentLaunch(workspace.id, bob.id, { command: '/bin/bash', args: [] })
    await store.startAgent(workspace.id, alice.id, { hivePort: '4010' })
    await store.startAgent(workspace.id, bob.id, { hivePort: '4010' })

    const cookie = await getUiCookie(baseUrl)
    const startResponse = await postJson(
      baseUrl,
      '/api/team/discuss/start',
      {
        members: ['Alice', 'Bob'],
        project_id: workspace.id,
        topic: 'report while discussing',
      },
      cookie
    )
    expect(startResponse.statusCode).toBe(201)

    await store.dispatchTask(workspace.id, alice.id, 'Do a concurrent dispatch')
    expect(store.getWorker(workspace.id, alice.id)).toMatchObject({
      pendingTaskCount: 1,
      status: 'working',
    })

    store.reportTask(workspace.id, alice.id, { status: 'success', text: 'Done' })

    expect(store.getWorker(workspace.id, alice.id)).toMatchObject({
      pendingTaskCount: 0,
      status: 'working',
    })
  })
})
