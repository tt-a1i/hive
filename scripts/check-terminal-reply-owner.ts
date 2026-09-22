/** Real HTTP/WebSocket/SQLite/PTY check; no browser, model or mocked transport. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import WebSocket from 'ws'
import { startTestServer } from '../tests/helpers/test-server.js'

const root = await mkdtemp(join(tmpdir(), 'hive-reply-owner-'))
const server = await startTestServer()
const sockets: WebSocket[] = []
let cookie = ''
const request = async (path: string, body?: object, status = body ? 201 : 200) => {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, status, await response.clone().text())
  return response
}
const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for real terminal evidence')
    await setTimeout(20)
  }
}
const barrier = async (socket: WebSocket) => {
  const pong = once(socket, 'pong', { signal: AbortSignal.timeout(10000) })
  socket.ping()
  await pong
}
try {
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  const script = join(root, 'echo.cjs')
  await writeFile(
    script,
    "process.stdin.setRawMode(true);let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);const size=[0,0];const error=process.stdout._handle.getWindowSize(size);if(error)throw new Error('getWindowSize failed');process.stdout.write('WIDTH:'+size[0]+':HEX:'+b.toString('hex')+':END\\r\\n')});process.stdout.write('READY\\r\\n')"
  )
  const workspace = await (
    await request('/api/workspaces', {
      name: 'Reply check',
      path: root,
      autostart_orchestrator: false,
    })
  ).json()
  const worker = await (
    await request(`/api/workspaces/${workspace.id}/workers`, { name: 'Echo', role: 'coder' })
  ).json()
  const agentPath = `/api/workspaces/${workspace.id}/agents/${worker.id}`
  await request(`${agentPath}/config`, { command: process.execPath, args: [script] }, 204)
  const run = await (
    await request(`${agentPath}/start`, { hive_port: new URL(server.baseUrl).port })
  ).json()
  const output = async () =>
    (await (await request(`/api/runtime/runs/${run.run_id}`)).json()).output as string
  await waitFor(async () => (await output()).includes('READY'))
  const viewer = async (id: string, modern: boolean) => {
    const connect = (channel: string) => {
      const ws = new WebSocket(
        `${server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${run.run_id}/${channel}?clientId=${id}${modern ? '&render_events=1' : ''}`,
        { headers: { cookie } }
      )
      sockets.push(ws)
      return ws
    }
    const io = connect('io')
    const control = connect('control')
    const restored = new Promise<void>((resolve) =>
      control.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'restore') resolve()
      })
    )
    const timeout = new AbortController()
    try {
      await Promise.race([
        Promise.all([once(io, 'open'), once(control, 'open'), restored]),
        setTimeout(10000, undefined, { signal: timeout.signal }).then(() => {
          throw new Error('Timed out connecting and restoring terminal viewer')
        }),
      ])
    } finally {
      timeout.abort()
    }
    return { io, control }
  }
  const old = await viewer('old', false)
  old.control.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))
  await barrier(old.control)
  const first = await viewer('first', true)
  const second = await viewer('second', true)
  const reply = (ws: WebSocket, data: string) =>
    ws.send(JSON.stringify({ type: 'input', data, cols: 80, rows: 24, user_input: false }))
  old.io.send('OLD')
  reply(second.io, 'DUPLICATE')
  await Promise.all([barrier(old.io), barrier(second.io)])
  reply(first.io, '\x1b[1;1R')
  await waitFor(async () => (await output()).includes('HEX:1b5b313b3152:END'))
  first.control.send(JSON.stringify({ type: 'resize', cols: 90, rows: 24 }))
  await barrier(first.control)
  // Keep the former owner's control socket open: only its IO disconnects.
  const closed = once(first.io, 'close')
  first.io.close()
  await closed
  reply(second.io, '\x1b[2;2R')
  await waitFor(async () => (await output()).includes('WIDTH:90:HEX:1b5b313b31521b5b323b3252:END'))
  console.log('PASS: legacy-first replies, single responder, disconnected IO owner fallback')
} finally {
  for (const socket of sockets) socket.terminate()
  await server.close()
  await rm(root, { recursive: true, force: true })
}
