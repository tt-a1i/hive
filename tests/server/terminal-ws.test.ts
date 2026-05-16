import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
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

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocket = async (url: string, cookie: string) => {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

const expectUpgradeStatus = async (
  url: string,
  cookie: string,
  statusCode: number,
  headers: Record<string, string> = {}
) => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(statusCode)
        response.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once('open', () => reject(new Error('Expected websocket upgrade to fail')))
    socket.once('error', () => {})
  })
}

const createWorkspace = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
  })
  return (await response.json()) as { id: string }
}

const createWorker = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
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
  const payload = (await response.json()) as { run_id: string }
  return { runId: payload.run_id }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('terminal websocket server', () => {
  test('streams PTY output over the io socket', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-output-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'ready.js')
    writeFileSync(
      script,
      [
        'let count = 0',
        'const interval = setInterval(() => {',
        '  count += 1',
        "  console.log('ready:' + count)",
        '  if (count >= 20) clearInterval(interval)',
        '}, 50)',
        'process.stdin.resume()',
      ].join('\n')
    )

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const io = await openSocket(toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/io`), cookie)
      const received: string[] = []

      io.on('message', (chunk) => {
        received.push(chunk.toString())
      })

      await waitFor(() => {
        expect(received.join('')).toContain('ready:')
      })

      io.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('forwards stdin from io socket into the PTY', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-stdin-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'echo.js')
    writeFileSync(
      script,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '})',
      ].join('\n')
    )

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const io = await openSocket(toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/io`), cookie)
      const received: string[] = []

      io.on('message', (chunk) => {
        received.push(chunk.toString())
      })
      io.send('hello from terminal\n')

      await waitFor(() => {
        expect(received.join('')).toContain('IN:hello from terminal')
      })

      io.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('rejects websocket upgrades for a missing run id', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'), cookie, 404)
    } finally {
      await server.close()
    }
  })

  test('rejects terminal websocket upgrades from non-local origins', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        403,
        {
          Origin: 'https://attacker.example',
        }
      )
    } finally {
      await server.close()
    }
  })

  test('allows terminal websocket upgrades from a local origin before run lookup', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        404,
        {
          Origin: server.baseUrl,
        }
      )
    } finally {
      await server.close()
    }
  })

  test('rejects terminal websocket upgrades from non-local hosts', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        403,
        {
          Host: 'attacker.example',
        }
      )
    } finally {
      await server.close()
    }
  })

  test('applies resize requests sent over the control socket', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-resize-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)

    const agentManager = createAgentManager()
    const resizeSpy = vi.spyOn(agentManager, 'resizeRun')
    const store = createRuntimeStore({ agentManager })
    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const workspace = await createWorkspace(baseUrl, cookie, workspacePath)
      const worker = await createWorker(baseUrl, cookie, workspace.id)
      await configureAgent(baseUrl, cookie, workspace.id, worker.id, '/bin/bash', [
        '-lc',
        "trap 'stty size' WINCH; echo ready; while true; do sleep 1; done",
      ])
      const run = await startAgent(baseUrl, cookie, workspace.id, worker.id)
      const control = await openSocket(
        toWsUrl(baseUrl, `/ws/terminal/${run.runId}/control`),
        cookie
      )
      control.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))

      await waitFor(() => {
        expect(resizeSpy).toHaveBeenCalledWith(run.runId, 120, 40)
      })

      control.close()
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  test('control socket receives an exit event when the PTY exits', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-exit-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'exit.js')
    writeFileSync(script, 'setTimeout(() => process.exit(0), 20)\n')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      const control = await openSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/control`),
        cookie
      )
      const messages: Array<{ code: number | null; type: string }> = []

      control.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as { code: number | null; type: string })
      })

      await waitFor(() => {
        expect(messages).toContainEqual({ type: 'exit', code: 0 })
      })

      control.close()
    } finally {
      await server.close()
    }
  })
})
