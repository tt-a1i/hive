import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headlessTerminalModule from '@xterm/headless'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import Database from '../../src/server/sqlite.js'

import { removeTestPath } from '../helpers/fs-cleanup.js'
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

const withTimeout = async <T>(label: string, promise: Promise<T>, timeoutMs = 5000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const toWsUrl = (baseUrl: string, suffix: string, clientId: string) => {
  return `${baseUrl.replace('http://', 'ws://')}${suffix}?clientId=${clientId}`
}

const createWorkspace = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath, autostart_orchestrator: false }),
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

const waitForRunOutput = async (
  baseUrl: string,
  cookie: string,
  runId: string,
  expected: string
) => {
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, {
      headers: { cookie },
    })
    const body = (await response.json()) as { output: string }
    expect(body.output).toContain(expected)
  })
}

const openViewer = async (
  baseUrl: string,
  cookie: string,
  runId: string,
  clientId: string,
  searchSuffix = ''
) => {
  const outputs: string[] = []
  const controlMessages: Array<{ [key: string]: unknown; type: string }> = []
  const io = new WebSocket(
    `${toWsUrl(baseUrl, `/ws/terminal/${runId}/io`, clientId)}${searchSuffix}`,
    {
      headers: { cookie },
    }
  )
  const control = new WebSocket(
    `${toWsUrl(baseUrl, `/ws/terminal/${runId}/control`, clientId)}${searchSuffix}`,
    {
      headers: { cookie },
    }
  )

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
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('terminal mirror', () => {
  test('rejects oversized input and control frames without changing the grid or writing input', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-grid-limit-${crypto.randomUUID()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'grid.js')
    writeFileSync(
      script,
      "process.stdin.setRawMode(true); let input=Buffer.alloc(0); process.stdin.on('data', bytes => { input=Buffer.concat([input,bytes]); const size=[0,0]; process.stdout._handle.getWindowSize(size); console.log('GRID:'+size.join('x')+':INPUT:'+input.toString('hex')+':END') }); console.log('GRID_READY')\n"
    )
    const server = await startTestServer()
    let viewer: Awaited<ReturnType<typeof openViewer>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const { runId } = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, runId, 'GRID_READY')
      viewer = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        crypto.randomUUID(),
        '&render_events=1'
      )
      const connected = viewer
      connected.io.send(JSON.stringify({ type: 'input', data: 'x', cols: 40, rows: 24 }))
      await waitForRunOutput(server.baseUrl, cookie, runId, 'GRID:40x24:INPUT:78:END')
      connected.control.send(JSON.stringify({ type: 'resize', cols: 32768, rows: 1 }))
      await waitFor(() =>
        expect(connected.controlMessages.some((message) => message.type === 'error')).toBe(true)
      )
      connected.io.send(JSON.stringify({ type: 'input', data: 'BAD', cols: 1001, rows: 1000 }))
      await waitFor(() =>
        expect(connected.outputs.some((raw) => JSON.parse(raw).type === 'error')).toBe(true)
      )
      // Automatic response does not resize; real child therefore reports the
      // retained grid, and cumulative bytes prove rejected input never arrived.
      connected.io.send(
        JSON.stringify({ type: 'input', data: 'z', cols: 40, rows: 24, user_input: false })
      )
      await waitForRunOutput(server.baseUrl, cookie, runId, 'GRID:40x24:INPUT:787a:END')
    } finally {
      viewer?.io.terminate()
      viewer?.control.terminate()
      await server.close()
    }
  }, 15000)
  test('mixed-version viewers must refresh before sending input or changing the owner grid', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-upgrade-${crypto.randomUUID()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'echo.js')
    writeFileSync(
      script,
      "let input=Buffer.alloc(0); process.stdin.setRawMode(true); process.stdin.on('data', bytes => { input=Buffer.concat([input,bytes]); console.log('INPUT_HEX:'+input.toString('hex')+':END') }); console.log('UPGRADE_READY')\n"
    )
    const server = await startTestServer()
    const sockets: WebSocket[] = []
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const { runId } = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, runId, 'UPGRADE_READY')
      const current = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        crypto.randomUUID(),
        '&render_events=1'
      )
      const old = await openViewer(server.baseUrl, cookie, runId, crypto.randomUUID())
      sockets.push(current.io, current.control, old.io, old.control)
      current.io.send(JSON.stringify({ type: 'input', data: 'a', cols: 40, rows: 20 }))
      await waitForRunOutput(server.baseUrl, cookie, runId, 'INPUT_HEX:61:END')
      old.io.send('b')
      old.control.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }))
      await waitFor(() =>
        expect(
          old.controlMessages.filter((m) => m.code === 'terminal_refresh_required').length
        ).toBeGreaterThanOrEqual(2)
      )
      const refreshed = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        crypto.randomUUID(),
        '&render_events=1'
      )
      sockets.push(refreshed.io, refreshed.control)
      refreshed.io.send(JSON.stringify({ type: 'input', data: 'z', cols: 120, rows: 30 }))
      await waitForRunOutput(server.baseUrl, cookie, runId, 'INPUT_HEX:617a:END')
      await waitFor(() => expect(current.outputs.join('')).toContain('"cols":120'))
    } finally {
      for (const socket of sockets) socket.terminate()
      await server.close()
    }
  }, 15000)

  test('replacement IO keeps streaming after the old socket with the same client ID closes', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-overlap-${crypto.randomUUID()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'echo.js')
    writeFileSync(
      script,
      "process.stdin.setRawMode(true); process.stdin.on('data', () => process.stdout.write('REPLACEMENT_ECHO')); console.log('OVERLAP_READY')\n"
    )
    const server = await startTestServer()
    const sockets: WebSocket[] = []
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'OVERLAP_READY')
      const clientId = crypto.randomUUID()
      const old = await openViewer(server.baseUrl, cookie, run.runId, clientId)
      sockets.push(old.io, old.control)
      await waitFor(() => expect(old.controlMessages.some((m) => m.type === 'restore')).toBe(true))
      const replacement = new WebSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/io`, clientId),
        { headers: { cookie } }
      )
      sockets.push(replacement)
      const outputs: string[] = []
      replacement.on('message', (chunk) => outputs.push(chunk.toString()))
      await withTimeout(
        'replacement open',
        new Promise<void>((resolve, reject) => {
          replacement.once('open', resolve)
          replacement.once('error', reject)
        })
      )
      await withTimeout(
        'old IO close',
        new Promise<void>((resolve) => {
          old.io.once('close', () => resolve())
          old.io.close()
        })
      )
      replacement.send('a')
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'REPLACEMENT_ECHO')
      await waitFor(() => expect(outputs.join('')).toContain('REPLACEMENT_ECHO'))
    } finally {
      for (const socket of sockets) socket.terminate()
      await server.close()
    }
  }, 15000)

  test('legacy control reconnect restores while its IO socket stays open', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-legacy-reconnect-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'hello.js')
    writeFileSync(script, "console.log('LEGACY_RESTORE'); process.stdin.resume()\n")
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'LEGACY_RESTORE')
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, '')
      await waitFor(() =>
        expect(viewer.controlMessages.some((message) => message.type === 'restore')).toBe(true)
      )
      const closed = new Promise<void>((resolve) => viewer.control.once('close', () => resolve()))
      viewer.control.close()
      await closed
      const control = new WebSocket(
        `${server.baseUrl.replace('http://', 'ws://')}/ws/terminal/${run.runId}/control`,
        { headers: { cookie } }
      )
      const messages: string[] = []
      control.on('message', (chunk) => messages.push(chunk.toString()))
      await waitFor(() => {
        const restored = messages
          .map((message) => JSON.parse(message))
          .find((message) => message.type === 'restore')
        expect(restored?.snapshot).toContain('LEGACY_RESTORE')
        expect(viewer.io.readyState).toBe(WebSocket.OPEN)
      })
      control.close()
      viewer.io.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('the input sender owns the shared grid and resize precedes output on both viewers', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-owner-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'owner.js')
    writeFileSync(
      script,
      [
        'process.stdin.setRawMode(true)',
        'let received = Buffer.alloc(0)',
        // Node's columns cache can update after stdin delivery on Windows.
        // Query the real window at receipt, not the asynchronous JS cache.
        "process.stdin.on('data', (chunk) => { received = Buffer.concat([received, chunk]); const size = [0, 0]; const error = process.stdout._handle.getWindowSize(size); if (error) throw new Error('Window size query failed: ' + error); process.stdout.write('WIDTH:' + size[0] + '\\r\\nINPUT_HEX:' + received.toString('hex') + ':END\\r\\n') })",
        "process.stdout.write('READY\\r\\n')",
      ].join('\n')
    )
    const server = await startTestServer()
    const viewers: Awaited<ReturnType<typeof openViewer>>[] = []
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const { runId } = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, runId, 'READY')
      const desktop = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        'owner-pc',
        '&render_events=1&cols=80&rows=24'
      )
      viewers.push(desktop)
      const phone = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        'owner-phone',
        '&render_events=1&cols=40&rows=24'
      )
      viewers.push(phone)
      await waitFor(() => {
        for (const viewer of viewers)
          expect(viewer.controlMessages.some((m) => m.type === 'restore')).toBe(true)
      })
      phone.io.send(JSON.stringify({ type: 'input', data: 'x', cols: 40, rows: 24 }))
      await waitForRunOutput(server.baseUrl, cookie, runId, 'WIDTH:40')
      for (const viewer of viewers) {
        await waitFor(() => {
          const frames = viewer.outputs.map((chunk) => JSON.parse(chunk))
          const resizeIndex = frames.findIndex(
            (frame) => frame.type === 'resize' && frame.cols === 40
          )
          const outputIndex = frames.findIndex(
            (frame) => frame.type === 'output' && frame.data.includes('WIDTH:40')
          )
          expect(resizeIndex).toBeGreaterThanOrEqual(0)
          expect(outputIndex).toBeGreaterThan(resizeIndex)
        })
      }
      desktop.io.send(
        JSON.stringify({ type: 'input', data: '\x1b[1;1R', cols: 120, rows: 24, user_input: false })
      )
      await withTimeout(
        'automatic reply processed',
        new Promise<void>((resolve) => {
          desktop.io.once('pong', () => resolve())
          desktop.io.ping()
        })
      )
      expect(
        desktop.outputs.some((chunk) => {
          const frame = JSON.parse(chunk)
          return frame.type === 'resize' && frame.cols === 120
        })
      ).toBe(false)
      desktop.control.send(JSON.stringify({ type: 'resize', cols: 120, rows: 24 }))
      phone.io.send(JSON.stringify({ type: 'input', data: 'y', cols: 40, rows: 24 }))
      // The pong proves the non-owner frame was processed before this input.
      // Assert the real child's cumulative bytes, not just unchanged geometry.
      await waitForRunOutput(server.baseUrl, cookie, runId, 'INPUT_HEX:7879:END')
      await waitFor(() =>
        expect(
          phone.outputs.filter((chunk) => JSON.parse(chunk).data?.includes('WIDTH:40')).length
        ).toBeGreaterThanOrEqual(2)
      )
      desktop.io.send(JSON.stringify({ type: 'input', data: 'z', cols: 100, rows: 24 }))
      await waitForRunOutput(server.baseUrl, cookie, runId, 'WIDTH:100')
      await waitForRunOutput(server.baseUrl, cookie, runId, 'INPUT_HEX:78797a:END')
      for (const viewer of viewers) {
        await waitFor(() =>
          expect(
            viewer.outputs.some((chunk) => {
              const frame = JSON.parse(chunk)
              return frame.type === 'resize' && frame.cols === 100
            })
          ).toBe(true)
        )
      }
    } finally {
      for (const viewer of viewers) {
        viewer.io.close()
        viewer.control.close()
      }
      await server.close()
    }
  }, 60000)

  test.each([
    80, 40,
  ])('viewer width %i does not change the grid used to interpret PTY output', async (firstCols) => {
    const workspacePath = join(tmpdir(), `hive-terminal-size-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'grid.js')
    const paint = '\x1b[2J\x1b[H\x1b[1;66HZ\x1b[3;1HDONE'
    writeFileSync(
      script,
      [
        'process.stdin.setRawMode(true)',
        'let count = 0',
        `process.stdin.on('data', () => process.stdout.write(++count === 1 ? ${JSON.stringify(paint)} : '\\x1b[1;66HQ\\x1b[3;1HEND'))`,
        "process.stdout.write('READY\\r\\n')",
      ].join('\n')
    )
    const server = await startTestServer()
    const viewers: Awaited<ReturnType<typeof openViewer>>[] = []
    const terminal = new headlessTerminalModule.Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const { runId } = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, runId, 'READY')
      viewers.push(
        await openViewer(server.baseUrl, cookie, runId, 'desktop', `&cols=${firstCols}&rows=24`)
      )
      viewers.push(await openViewer(server.baseUrl, cookie, runId, 'mobile', '&cols=40&rows=24'))
      viewers[0]?.io.send('x')
      await waitForRunOutput(server.baseUrl, cookie, runId, 'DONE')
      viewers[0]?.io.send('y')
      await waitForRunOutput(server.baseUrl, cookie, runId, 'END')
      const restored = await openViewer(
        server.baseUrl,
        cookie,
        runId,
        'restored',
        '&cols=80&rows=24'
      )
      viewers.push(restored)
      await waitFor(() =>
        expect(restored.controlMessages.some((message) => message.type === 'restore')).toBe(true)
      )
      const snapshot = String(
        restored.controlMessages.find((message) => message.type === 'restore')?.snapshot
      )
      await new Promise<void>((resolve) => terminal.write(snapshot, resolve))
      const buffer = terminal.buffer.active
      expect(buffer.getLine(buffer.baseY)?.translateToString(true)).toBe(`${' '.repeat(65)}Q`)
      expect(buffer.getLine(buffer.baseY + 2)?.translateToString(true)).toBe('ENDE')
      expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([3, 2])
    } finally {
      terminal.dispose()
      for (const viewer of viewers) {
        viewer.io.close()
        viewer.control.close()
      }
      await server.close()
    }
  }, 60000)

  test('output between IO attach and snapshot is restored exactly once', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-restore-race-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'restore-race.js')
    writeFileSync(
      script,
      [
        'process.stdin.setRawMode(true)',
        "process.stdin.on('data', (data) => process.stdout.write(data.toString().includes('x') ? 'RACE_MARKER\\r\\n' : 'AFTER_MARKER\\r\\n'))",
        "process.stdout.write('READY\\r\\n')",
      ].join('\n')
    )
    const server = await startTestServer()
    const sockets: WebSocket[] = []
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const { runId } = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, runId, 'READY')
      const outputs: string[] = []
      const io = new WebSocket(toWsUrl(server.baseUrl, `/ws/terminal/${runId}/io`, 'race'), {
        headers: { cookie },
      })
      sockets.push(io)
      io.on('message', (data) => outputs.push(data.toString()))
      await withTimeout(
        'IO open',
        new Promise<void>((resolve, reject) => {
          io.once('open', resolve)
          io.once('error', reject)
        })
      )
      io.send('x')
      await waitForRunOutput(server.baseUrl, cookie, runId, 'RACE_MARKER')
      const control = new WebSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${runId}/control`, 'race'),
        { headers: { cookie } }
      )
      sockets.push(control)
      const snapshot = await withTimeout(
        'restore',
        new Promise<string>((resolve, reject) => {
          control.on('message', (data) => {
            const message = JSON.parse(data.toString())
            if (message.type === 'restore') resolve(message.snapshot)
          })
          control.once('error', reject)
        })
      )
      control.send(JSON.stringify({ type: 'restore_complete' }))
      io.send('y')
      await waitFor(() => expect(outputs.join('')).toContain('AFTER_MARKER'))
      expect((snapshot + outputs.join('')).match(/RACE_MARKER/g)).toHaveLength(1)
    } finally {
      for (const socket of sockets) socket.close()
      await server.close()
    }
  }, 60000)

  test('preserves mixed UTF-8 when multibyte code points cross PTY chunks in live output and restore', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-utf8-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'utf8-split.js')
    const expected = '边界中文😀，English `code`'
    writeFileSync(
      script,
      [
        `const bytes = Buffer.from(${JSON.stringify(expected)}, 'utf8')`,
        "process.stdout.write('READY\\n')",
        'let offset = 0',
        'setTimeout(() => {',
        '  const timer = setInterval(() => {',
        '    process.stdout.write(bytes.subarray(offset, offset + 1))',
        '    offset += 1',
        '    if (offset === bytes.length) { clearInterval(timer); process.stdout.write("\\nDONE\\n") }',
        '  }, 8)',
        '}, 250)',
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
      const liveViewer = await openViewer(server.baseUrl, cookie, run.runId, 'utf8-live')

      await waitFor(() => {
        expect(liveViewer.outputs.join('')).toContain(expected)
        expect(liveViewer.outputs.join('')).not.toContain('\uFFFD')
      }, 15000)
      const payloadFrames = liveViewer.outputs.filter((frame) =>
        [...expected].some((character) => frame.includes(character))
      )
      expect(payloadFrames.length).toBeGreaterThan(3)
      expect(payloadFrames).not.toContain(expected)

      const restoreViewer = await openViewer(server.baseUrl, cookie, run.runId, 'utf8-restore')
      await waitFor(() => {
        const restore = restoreViewer.controlMessages.find((message) => message.type === 'restore')
        const snapshot = String(restore?.snapshot ?? '')
        expect(snapshot).toContain(expected)
        expect(snapshot).not.toContain('\uFFFD')
      }, 15000)

      liveViewer.io.close()
      liveViewer.control.close()
      restoreViewer.io.close()
      restoreViewer.control.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test('T1 late attach gets a restore snapshot with prior output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-restore-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'hello.js')
    writeFileSync(
      script,
      "console.log('HELLO'); process.stdin.resume(); setInterval(() => {}, 1000)\n"
    )

    const server = await withTimeout('test server', startTestServer())
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.baseUrl, cookie, workspace.id, worker.id, process.execPath, [
        script,
      ])
      const run = await startAgent(server.baseUrl, cookie, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'HELLO')

      const secondViewer = await openViewer(server.baseUrl, cookie, run.runId, 'late-viewer')
      await waitFor(() => {
        const restore = secondViewer.controlMessages.find((message) => message.type === 'restore')
        expect(String(restore?.snapshot ?? '')).toContain('HELLO')
      })

      secondViewer.io.close()
      secondViewer.control.close()
    } finally {
      await server.close()
    }
  }, 60000)

  test.skipIf(process.platform === 'win32')(
    'T1b restore mirror uses initial control socket dimensions before replaying output',
    async () => {
      const workspacePath = join(tmpdir(), `hive-terminal-mirror-wide-${Date.now()}`)
      mkdirSync(workspacePath, { recursive: true })
      tempDirs.push(workspacePath)
      const script = join(workspacePath, 'wide.js')
      const wideText = `LEFT${'x'.repeat(90)}RIGHT`
      writeFileSync(
        script,
        [
          `process.stdout.write(${JSON.stringify(wideText)})`,
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
        const run = await withTimeout(
          'wide agent start',
          startAgent(server.baseUrl, cookie, workspace.id, worker.id)
        )

        await withTimeout(
          'wide run output',
          waitForRunOutput(server.baseUrl, cookie, run.runId, 'RIGHT')
        )

        const viewer = await withTimeout(
          'wide viewer sockets',
          openViewer(server.baseUrl, cookie, run.runId, 'wide-viewer', '&cols=120&rows=5')
        )

        await withTimeout(
          'wide restore snapshot',
          waitFor(() => {
            const restore = viewer.controlMessages.find((message) => message.type === 'restore')
            const snapshot = String(restore?.snapshot ?? '')
            expect(snapshot).toContain(wideText)
          })
        )

        viewer.io.close()
        viewer.control.close()
      } finally {
        await server.close()
      }
    },
    60000
  )

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

      viewerA.io.send('world\r')

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

      viewerA.io.send('after close\r')

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
  }, 60000)

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

      const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readOnly: true })
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
