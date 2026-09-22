import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { openRawWebSocket, writeRsv2Rsv3MalformedFrame } from '../helpers/raw-websocket.js'
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
    body: JSON.stringify({
      name: 'Alpha',
      path: workspacePath,
      autostart_orchestrator: false,
    }),
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
      io.send(`hello from terminal${process.platform === 'win32' ? '\r' : '\n'}`)

      await waitFor(() => {
        expect(received.join('')).toContain('IN:hello from terminal')
      })

      io.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('forwards binary stdin from io socket into the PTY', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-binary-stdin-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'hex.js')
    writeFileSync(
      script,
      [
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        'process.stdin.resume()',
        "const ready = setInterval(() => console.log('READY'), 100)",
        "console.log('READY')",
        "process.stdin.on('data', (chunk) => {",
        '  clearInterval(ready)',
        "  process.stdout.write('HEX:' + chunk.toString('hex') + '\\n')",
        '})',
      ].join('\n')
    )

    const server = await startTestServer()
    let io: WebSocket | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      io = await openSocket(toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/io`), cookie)
      const received: string[] = []

      io.on('message', (chunk) => {
        received.push(chunk.toString())
      })

      await waitFor(() => {
        expect(received.join('')).toContain('READY')
      }, 10000)
      // Non-control high-bit bytes catch accidental UTF-8 text decoding
      // without triggering Windows ConPTY escape-sequence handling.
      io.send(Buffer.from([0xc3, 0xa9, 0x21]))

      await waitFor(() => {
        expect(received.join('')).toContain('HEX:c383c2a921')
      }, 10000)

      io.close()
    } finally {
      io?.close()
      await server.close()
    }
  }, 60000)

  test('malformed established websocket frames are handled without crashing the runtime', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspacePath = join(tmpdir(), `hive-terminal-malformed-ws-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'idle.js')
    writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")

    const server = await startTestServer()
    let rawSocket: Awaited<ReturnType<typeof openRawWebSocket>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      rawSocket = await openRawWebSocket(server.baseUrl, `/ws/terminal/${run.runId}/io`, cookie)

      writeRsv2Rsv3MalformedFrame(rawSocket)

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining(`terminal ${run.runId} io websocket error`),
          expect.objectContaining({
            code: 'WS_ERR_UNEXPECTED_RSV_2_3',
            message: 'Invalid WebSocket frame: RSV2 and RSV3 must be clear',
          })
        )
      })
      const response = await fetch(`${server.baseUrl}/api/ui/session`)
      expect(response.status).toBe(200)
    } finally {
      rawSocket?.destroy()
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
      const script = join(workspacePath, 'resize-idle.js')
      writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
      await configureAgent(baseUrl, cookie, workspace.id, worker.id, process.execPath, [script])
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

  test('rejects invalid resize dimensions before reaching the PTY manager', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-bad-resize-${Date.now()}`)
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
      const script = join(workspacePath, 'resize-idle.js')
      writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
      await configureAgent(baseUrl, cookie, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(baseUrl, cookie, workspace.id, worker.id)
      const control = await openSocket(
        toWsUrl(baseUrl, `/ws/terminal/${run.runId}/control`),
        cookie
      )
      const messages: Array<{ message?: string; type: string }> = []
      control.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as { message?: string; type: string })
      })

      control.send(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }))

      await waitFor(() => {
        expect(messages).toContainEqual({
          type: 'error',
          message: 'Invalid terminal control message',
        })
      })
      expect(resizeSpy).not.toHaveBeenCalledWith(run.runId, 0, 40)
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

  test('workspace shell control socket receives an exit event when the shell exits', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-shell-exit-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)

    const server = await startTestServer()
    let control: WebSocket | undefined
    let io: WebSocket | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(startResponse.status).toBe(201)
      const shell = (await startResponse.json()) as { run_id: string }
      control = await openSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${shell.run_id}/control`),
        cookie
      )
      io = await openSocket(toWsUrl(server.baseUrl, `/ws/terminal/${shell.run_id}/io`), cookie)
      const messages: Array<{ code: number | null; type: string }> = []

      control.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as { code: number | null; type: string })
      })
      io.send(process.platform === 'win32' ? 'exit\r' : 'exit\n')

      await waitFor(() => {
        expect(messages).toContainEqual({ type: 'exit', code: 0 })
      })

      control.close()
      io.close()
    } finally {
      control?.close()
      io?.close()
      await server.close()
    }
  })
})
