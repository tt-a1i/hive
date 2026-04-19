import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTerminalOutputFlow, FLOW_CONTROL } from '../../src/server/terminal-flow-control.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const defaultFlowControl = { ...FLOW_CONTROL }

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 20
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

const toWsUrl = (baseUrl: string, suffix: string, clientId: string) => {
  return `${baseUrl.replace('http://', 'ws://')}${suffix}?clientId=${clientId}`
}

const startSpyServer = async () => {
  const agentManager = createAgentManager()
  const pauseSpy = vi.spyOn(agentManager, 'pauseRun')
  const resumeSpy = vi.spyOn(agentManager, 'resumeRun')
  const store = createRuntimeStore({ agentManager })
  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }
  return {
    agentManager,
    baseUrl: `http://127.0.0.1:${address.port}`,
    pauseSpy,
    resumeSpy,
    close: async () => {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  }
}

const createWorkspace = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const createWorker = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const configureAgent = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string,
  command: string,
  args: string[]
) => {
  const response = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command, args }),
    }
  )
  expect(response.status).toBe(204)
}

const startAgent = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string
) => {
  const port = baseUrl.split(':').at(-1)
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ hive_port: port }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { runId: string }
}

const openViewer = async (baseUrl: string, cookie: string, runId: string, clientId: string) => {
  const outputs: string[] = []
  const messageEvents: string[] = []
  const io = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/io`, clientId), {
    headers: { cookie },
  })
  const control = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/control`, clientId), {
    headers: { cookie },
  })

  io.on('message', (chunk) => {
    const text = chunk.toString()
    outputs.push(text)
    messageEvents.push(text)
  })

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      io.once('open', () => resolve())
      io.once('error', reject)
    }),
    new Promise<void>((resolve, reject) => {
      control.once('open', () => resolve())
      control.once('error', reject)
    }),
  ])

  return { control, io, messageEvents, outputs }
}

afterEach(() => {
  Object.assign(FLOW_CONTROL, defaultFlowControl)
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('terminal flow control', () => {
  test('T1 low-latency small chunk is sent without waiting for batch timer', async () => {
    Object.assign(FLOW_CONTROL, { BATCH_INTERVAL_MS: 800 })
    const workspacePath = join(tmpdir(), `hive-terminal-flow-direct-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'small.js')
    writeFileSync(
      script,
      [
        "console.log('ready')",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => { process.stdout.write('IN:' + chunk) })",
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, '/bin/bash', [
        '-lc',
        `stty -echo; exec ${process.execPath} ${script}`,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')

      await waitFor(() => {
        expect(viewer.outputs.join('')).toContain('ready')
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      const startAt = Date.now()
      viewer.io.send('tiny\n')

      await waitFor(
        () => {
          expect(viewer.outputs.join('')).toContain('IN:tiny')
        },
        300,
        10
      )
      expect(Date.now() - startAt).toBeLessThan(300)

      viewer.io.close()
      viewer.control.close()
    } finally {
      await server.close()
    }
  }, 15000)

  test('T2 multiple >256B chunks batch into one websocket send', async () => {
    Object.assign(FLOW_CONTROL, { BATCH_INTERVAL_MS: 50 })
    const workspacePath = join(tmpdir(), `hive-terminal-flow-batch-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'batch.js')
    const chunkA = `A:${'x'.repeat(300)}`
    const chunkB = `B:${'y'.repeat(300)}`
    const chunkC = `C:${'z'.repeat(300)}`
    writeFileSync(
      script,
      [
        `const chunks = ${JSON.stringify([chunkA, chunkB, chunkC])};`,
        'setTimeout(() => { for (const chunk of chunks) process.stdout.write(chunk) }, 20)',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')

      await waitFor(() => {
        expect(viewer.messageEvents).toHaveLength(1)
        expect(viewer.outputs.join('')).toContain(chunkA)
        expect(viewer.outputs.join('')).toContain(chunkB)
        expect(viewer.outputs.join('')).toContain(chunkC)
      })

      viewer.io.close()
      viewer.control.close()
    } finally {
      await server.close()
    }
  }, 15000)

  test('T3 unacked bytes above 100KB pauses the PTY', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-unacked-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'burst.js')
    writeFileSync(
      script,
      [
        'setTimeout(() => {',
        "  const chunk = 'u'.repeat(4096)",
        '  setInterval(() => process.stdout.write(chunk), 1)',
        '}, 20)',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')

      await waitFor(
        () => {
          expect(server.pauseSpy).toHaveBeenCalledWith(run.runId)
        },
        8000,
        20
      )

      viewer.io.close()
      viewer.control.close()
    } finally {
      await server.close()
    }
  }, 15000)

  test('T4 a slow viewer blocks resume until it disconnects', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-multi-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'multi.js')
    writeFileSync(
      script,
      [
        'setTimeout(() => {',
        "  const chunk = 'm'.repeat(8192)",
        '  setInterval(() => process.stdout.write(chunk), 2)',
        '}, 20)',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const fastViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-fast')
      const slowViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-slow')

      await waitFor(
        () => {
          expect(server.pauseSpy).toHaveBeenCalledWith(run.runId)
        },
        8000,
        20
      )

      fastViewer.control.send(JSON.stringify({ type: 'output_ack', bytes: 200_000 }))

      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(server.resumeSpy).not.toHaveBeenCalled()

      slowViewer.io.close()
      slowViewer.control.close()

      await waitFor(
        () => {
          expect(server.resumeSpy).toHaveBeenCalledWith(run.runId)
        },
        8000,
        20
      )

      fastViewer.io.close()
      fastViewer.control.close()
    } finally {
      await server.close()
    }
  }, 15000)

  test('T5 bufferedAmount high water pauses and resumes the PTY', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-buffered-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'buffered.js')
    writeFileSync(
      script,
      [
        "setTimeout(() => process.stdout.write('b'.repeat(20 * 1024)), 20)",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const manager = createAgentManager()
    const wss = new WebSocketServer({ port: 0 })
    let flow: ReturnType<typeof createTerminalOutputFlow> | undefined
    let bufferedAmount = FLOW_CONTROL.WS_BUFFERED_HIGH_WATER
    const socketReady = new Promise<void>((resolve) => {
      wss.once('connection', (socket) => {
        Object.defineProperty(socket, 'bufferedAmount', {
          configurable: true,
          get: () => bufferedAmount,
        })
        flow = createTerminalOutputFlow(socket, {
          onBackpressureChange(backpressured) {
            if (backpressured) pauseSpy()
            else resumeSpy()
          },
        })
        resolve()
      })
    })

    const port = (wss.address() as { port: number }).port
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })
    await socketReady

    const run = await manager.startAgent({
      agentId: 'worker-buffered',
      command: process.execPath,
      args: [script],
      cwd: workspacePath,
      env: {},
    })
    const pauseSpy = vi.fn(() => manager.pauseRun(run.runId))
    const resumeSpy = vi.fn(() => manager.resumeRun(run.runId))
    const unsubscribe = manager.getOutputBus().subscribe(run.runId, (chunk) => flow?.enqueue(chunk))

    try {
      await waitFor(
        () => {
          expect(pauseSpy).toHaveBeenCalledTimes(1)
        },
        8000,
        20
      )

      bufferedAmount = 0

      await waitFor(
        () => {
          expect(resumeSpy).toHaveBeenCalledTimes(1)
        },
        8000,
        20
      )
    } finally {
      unsubscribe()
      flow?.close()
      client.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      manager.stopRun(run.runId)
    }
  }, 15000)
})
