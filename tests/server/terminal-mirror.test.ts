import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
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
  const payload = (await response.json()) as { run_id: string }
  return { runId: payload.run_id }
}

const openViewer = async (baseUrl: string, cookie: string, runId: string, clientId: string) => {
  const outputs: string[] = []
  const controlMessages: Array<{ [key: string]: unknown; type: string }> = []
  const io = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/io`, clientId), {
    headers: { cookie },
  })
  const control = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/control`, clientId), {
    headers: { cookie },
  })

  io.on('message', (chunk) => outputs.push(chunk.toString()))
  control.on('message', (chunk) => {
    controlMessages.push(JSON.parse(chunk.toString()) as { [key: string]: unknown; type: string })
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

  return { io, control, outputs, controlMessages }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('terminal mirror', () => {
  test('T1 late attach gets a restore snapshot with prior output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-restore-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'hello.js')
    writeFileSync(
      script,
      "console.log('HELLO'); process.stdin.resume(); setInterval(() => {}, 1000)\n"
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

      const firstViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-1')
      await waitFor(() => {
        expect(firstViewer.outputs.join('')).toContain('HELLO')
      })

      const secondViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-2')
      await waitFor(() => {
        const restore = secondViewer.controlMessages.find((message) => message.type === 'restore')
        expect(String(restore?.snapshot ?? '')).toContain('HELLO')
      })

      firstViewer.io.close()
      firstViewer.control.close()
      secondViewer.io.close()
      secondViewer.control.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('T1b restore mirror uses initial control socket dimensions before replaying output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-wide-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'wide.js')
    writeFileSync(
      script,
      [
        "process.stdout.write('LEFT\\x1b[100CRIGHT')",
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
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

      await waitFor(async () => {
        const response = await fetch(`${server.baseUrl}/api/runtime/runs/${run.runId}`, {
          headers: { cookie },
        })
        const body = (await response.json()) as { output: string }
        expect(body.output).toContain('RIGHT')
      })

      const controlMessages: Array<{ [key: string]: unknown; type: string }> = []
      const control = new WebSocket(
        `${server.baseUrl.replace('http://', 'ws://')}/ws/terminal/${run.runId}/control?clientId=wide-viewer&cols=120&rows=5`,
        { headers: { cookie } }
      )
      control.on('message', (chunk) => {
        controlMessages.push(
          JSON.parse(chunk.toString()) as { [key: string]: unknown; type: string }
        )
      })
      await new Promise<void>((resolve, reject) => {
        control.once('open', () => resolve())
        control.once('error', reject)
      })

      await waitFor(() => {
        const restore = controlMessages.find((message) => message.type === 'restore')
        const snapshot = String(restore?.snapshot ?? '')
        expect(snapshot).toContain('LEFT')
        expect(snapshot).toContain('\u001b[100CRIGHT')
        expect(snapshot).not.toContain('\u001b[75CRIGHT')
      })

      control.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('T2 multiple viewers each receive one copy of future PTY output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-fanout-${Date.now()}`)
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

      const viewerA = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      const viewerB = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-b')

      viewerA.io.send('world\n')

      await waitFor(() => {
        expect(viewerA.outputs.join('')).toContain('IN:world')
        expect(viewerB.outputs.join('')).toContain('IN:world')
      })

      expect(viewerA.outputs.join('').match(/IN:world/g)).toHaveLength(1)
      expect(viewerB.outputs.join('').match(/IN:world/g)).toHaveLength(1)

      viewerA.io.close()
      viewerA.control.close()
      viewerB.io.close()
      viewerB.control.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('T3 closing one viewer does not stop output for remaining viewers', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-detach-${Date.now()}`)
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

      const viewerA = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      const viewerB = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-b')
      const viewerC = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-c')

      viewerB.io.close()
      viewerB.control.close()
      await new Promise((resolve) => setTimeout(resolve, 50))

      viewerA.io.send('after close\n')

      await waitFor(() => {
        expect(viewerA.outputs.join('')).toContain('IN:after close')
        expect(viewerC.outputs.join('')).toContain('IN:after close')
      })

      viewerA.io.close()
      viewerA.control.close()
      viewerC.io.close()
      viewerC.control.close()
    } finally {
      await server.close()
    }
  })

  test('T4 PTY transcript is not persisted into sqlite messages', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-db-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'secret.js')
    writeFileSync(
      script,
      "console.log('SECRET_TEXT'); process.stdin.resume(); setInterval(() => {}, 1000)\n"
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
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')

      await waitFor(() => {
        expect(viewer.outputs.join('')).toContain('SECRET_TEXT')
      })

      const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM messages WHERE text LIKE ?')
        .get('%SECRET_TEXT%') as { count: number }
      db.close()

      expect(row.count).toBe(0)

      viewer.io.close()
      viewer.control.close()
    } finally {
      await server.close()
    }
  })
})
