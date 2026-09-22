import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import WebSocket from 'ws'
import { buildXterm } from './build-xterm.mjs'

const root = resolve(import.meta.dirname, '..')
const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)
if (!chromePath) throw new Error('Chrome required')
const previousDataDir = process.env.HIVE_DATA_DIR
const fixtureDir = mkdtempSync(join(tmpdir(), 'hive-input-runtime-'))
let hive
let server
let chrome
let socket
const failures = []
try {
  process.env.HIVE_DATA_DIR = fixtureDir
  const { runHiveCommand } = await import(pathToFileURL(join(root, 'dist/src/cli/hive.js')).href)
  hive = await runHiveCommand(['--port', '0', '--no-open'], {
    versionService: { getVersionInfo: async () => ({ update_available: false }) },
  })
  const base = `http://127.0.0.1:${hive.port}`
  const session = await fetch(base + '/api/ui/session')
  const cookie = session.headers.get('set-cookie').split(';')[0]
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.ok(response.ok, `fixture HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const workspace = await request('/api/workspaces', {
    name: 'Isolated input test',
    path: fixtureDir,
    autostart_orchestrator: false,
  })
  await request(`/api/workspaces/${workspace.id}/agents/${workspace.id}:orchestrator/config`, {
    command: process.execPath,
    args: [join(root, 'tests/browser/terminal-echo.mjs')],
  })
  const run = await request(
    `/api/workspaces/${workspace.id}/agents/${workspace.id}:orchestrator/start`,
    {}
  )
  server = await createServer({
    configFile: false,
    root,
    resolve: {
      alias: [{ find: /^@xterm\/xterm$/, replacement: await buildXterm() }],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom/client',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-unicode11',
        '@xterm/addon-clipboard',
        '@xterm/addon-web-links',
        '@xterm/addon-webgl',
      ],
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': base, '/ws': { target: base, ws: true } },
    },
  })
  await server.listen()
  const profileDir = mkdtempSync(join(tmpdir(), 'hive-input-browser-'))
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
  let chromeError
  chrome.once('error', (error) => {
    chromeError = error
  })
  let target
  for (let i = 0; i < 100; i++) {
    if (chromeError) throw chromeError
    if (chrome.exitCode !== null || chrome.signalCode !== null)
      throw new Error('Isolated Chrome exited')
    try {
      const [port, browserPath] = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8')
        .trim()
        .split(/\r?\n/)
      assert.match(port, /^\d+$/)
      assert.ok(browserPath?.startsWith('/devtools/browser/'))
      const endpoint = `http://127.0.0.1:${port}`
      const version = await (
        await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
      ).json()
      assert.equal(
        new URL(version.webSocketDebuggerUrl).pathname,
        browserPath,
        'browser belongs to this isolated profile'
      )
      target = await (
        await fetch(`${endpoint}/json/new?about:blank`, {
          method: 'PUT',
          signal: AbortSignal.timeout(1000),
        })
      ).json()
      break
    } catch (error) {
      if (i === 99) throw error
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const pending = new Map()
  let id = 0
  socket.on('message', (raw) => {
    const m = JSON.parse(raw)
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      clearTimeout(p.timer)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => {
        pending.delete(n)
        reject(new Error(`${method} timed out`))
      }, 10000)
      pending.set(n, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: n, method, params }))
    })
  await call('Page.enable')
  await call('Runtime.enable')
  const port = server.httpServer.address().port
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/tests/browser/terminal-input.html` })
  for (let i = 0; i < 100; i++) {
    const r = await call('Runtime.evaluate', { expression: 'window.ready', returnByValue: true })
    if (r.result.value) break
    if (i === 99) throw new Error('Browser fixture did not load')
    await new Promise((r) => setTimeout(r, 50))
  }
  const r = await call('Runtime.evaluate', {
    expression: 'window.probe()',
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  console.log(JSON.stringify(r.result.value, null, 2))
  for (const c of r.result.value) assert.equal(c.actual, c.expected, c.name)
  await call('Runtime.evaluate', {
    expression: `fetch('/api/ui/session').then(()=>window.mountRuntime(${JSON.stringify(run.run_id)}))`,
    awaitPromise: true,
  })
  for (let i = 0; i < 100; i++) {
    const status = await call('Runtime.evaluate', {
      expression: 'window.runtimeStatus',
      returnByValue: true,
    })
    if (status.result.value === 'running') break
    if (i === 99) throw new Error('Production terminal hook did not connect')
    await new Promise((r) => setTimeout(r, 50))
  }
  const readPtyInput = async () => {
    const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers: { cookie } })
    const record = await response.json()
    return Buffer.concat(
      [...record.output.matchAll(/INPUT_HEX:([0-9a-f]+)/g)].map((match) =>
        Buffer.from(match[1], 'hex')
      )
    ).toString('utf8')
  }
  const waitForPtyInput = async (marker) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const received = await readPtyInput()
      if (received.includes(marker)) return received
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail('PTY input receipt marker missing')
  }
  await call('Runtime.evaluate', { expression: 'window.sendFrom(0,"__INPUT_BEGIN__")' })
  await waitForPtyInput('__INPUT_BEGIN__')
  const live = await call('Runtime.evaluate', {
    expression: 'window.probe()',
    returnByValue: true,
    awaitPromise: true,
  })
  if (live.exceptionDetails) throw new Error(live.exceptionDetails.text)
  for (const c of live.result.value)
    assert.equal(c.actual, c.expected, `production hook/WS ${c.name}`)
  await call('Runtime.evaluate', { expression: 'window.sendFrom(0,"__INPUT_END__")' })
  const received = await waitForPtyInput('__INPUT_END__')
  const actualInput = received
    .split('__INPUT_BEGIN__')[1]
    .split('__INPUT_END__')[0]
    .replaceAll('\x1b[I', '')
    .replaceAll('\x1b[O', '')
  assert.equal(
    actualInput,
    live.result.value.map((entry) => entry.expected).join(''),
    'the complete input matrix reaches the real PTY exactly once'
  )
  console.log(
    JSON.stringify({
      realPtyInputCases: live.result.value.length,
      receivedBytes: Buffer.byteLength(actualInput),
    })
  )
  console.log(JSON.stringify({ productionHookAndWebSocketCases: live.result.value.length }))
  await call('Runtime.evaluate', { expression: 'window.runtimeWrites="";window.requestRepaint()' })
  let observed = ''
  for (let i = 0; i < 100; i++) {
    observed = (
      await call('Runtime.evaluate', { expression: 'window.runtimeWrites', returnByValue: true })
    ).result.value
    if (observed.includes('REPAINT_DONE')) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(observed.includes('REPAINT_DONE'), 'real PTY repaint completed')
  const runtimeRun = await (
    await fetch(base + '/api/runtime/runs/' + run.run_id, { headers: { cookie } })
  ).json()
  const marker = 'INPUT_HEX:5f5f52455041494e545f5f'
  assert.ok(runtimeRun.output.includes(marker), 'PTY received the browser input through Hive WS')
  assert.equal(
    observed.slice(observed.lastIndexOf(marker)),
    runtimeRun.output.slice(runtimeRun.output.lastIndexOf(marker)),
    'actual PTY bytes reach xterm unchanged through the production hook'
  )
  for (let i = 0; i < 20; i++) await call('Runtime.evaluate', { expression: 'window.rerender()' })
  const count = (
    await call('Runtime.evaluate', { expression: 'window.createdCount', returnByValue: true })
  ).result.value
  assert.equal(count, 1, 'ordinary React renders retain one terminal instance')
  console.log(JSON.stringify({ realPtyRepaint: true, terminalInstances: count }))
  const evaluate = async (expression) =>
    (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value
  const waitForBrowser = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail(`Browser condition failed: ${expression}`)
  }
  const desktopGrid = (await evaluate('window.readGrids()'))[0]
  await evaluate('window.mountPeer(390)')
  await waitForBrowser('window.readGrids().length===2')
  await evaluate('window.sendFrom(1,"PEER_SIZE")')
  await waitForBrowser(
    `window.readGrids().every(g=>g.cols===window.readGrids()[0].cols) && window.readGrids()[0].cols<${desktopGrid.cols}`
  )
  const phoneGrid = (await evaluate('window.readGrids()'))[0]
  // ConPTY can consume DSR itself. Exercise actual browser xterm responses at
  // the renderer boundary, then send them through the real Hive WS/PTY path.
  await evaluate('window.autoResponses=[];window.resizeEvents=[];window.queryPeers()')
  await waitForBrowser('window.autoResponses.length>=4')
  assert.deepEqual(
    await evaluate('window.readGrids()'),
    [phoneGrid, phoneGrid],
    'terminal automatic replies must not take ownership'
  )
  assert.deepEqual(
    await evaluate('window.resizeEvents'),
    [],
    'automatic replies must not trigger even a transient resize'
  )
  await evaluate('window.resizeHost(0,900)')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(
    await evaluate('window.readGrids()'),
    [phoneGrid, phoneGrid],
    'passive PC resize must not steal ownership'
  )
  await evaluate('window.sendFrom(0,"DESKTOP_SIZE")')
  await waitForBrowser(
    `window.readGrids().every(g=>g.cols===window.readGrids()[0].cols) && window.readGrids()[0].cols>${phoneGrid.cols}`
  )
  assert.equal(
    await evaluate('window.createdCount'),
    2,
    'ownership changes keep both terminal instances'
  )
  await evaluate('window.focusFrom(1)')
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    text: 'a',
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  })
  await waitForBrowser(`window.readGrids().every(g=>g.cols===${phoneGrid.cols})`)
  await evaluate('window.sendFrom(0,"MOUSE_HANDOFF")')
  await waitForBrowser(`window.readGrids().every(g=>g.cols>${phoneGrid.cols})`)
  await call('Runtime.evaluate', { expression: 'window.enableMouse(1)', awaitPromise: true })
  const point = await evaluate('window.mousePoint(1)')
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  await waitForBrowser(`window.readGrids().every(g=>g.cols===${phoneGrid.cols})`)
  console.log(
    JSON.stringify({
      inputOwnerGrid: await evaluate('window.readGrids()'),
      phoneGrid,
      sharedGridVerified: true,
      automaticReplyCount: await evaluate('window.autoResponses.length'),
    })
  )
  // Real PTY background paints preserve a live input row while native Chrome
  // keys and periodic real team reads rerender the same production hook.
  await evaluate('window.focusFrom(0);window.sendFrom(0,"__STRESS_START__")')
  await waitForBrowser('window.readTerminal(0).lines[0].startsWith("STRESS_TICK:")')
  for (let index = 0; index < 100; index++) {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'a',
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })
  }
  const expectedDraft = `> ${'a'.repeat(100)}`
  await waitForBrowser(`window.readTerminal(0).lines[1]===${JSON.stringify(expectedDraft)}`)
  const stressStarted = performance.now()
  let teamReads = 0
  let previousTick = -1
  while (performance.now() - stressStarted < 120_000) {
    const result = await call('Runtime.evaluate', {
      expression: `fetch('/api/ui/workspaces/${workspace.id}/team').then(async r=>{if(!r.ok)throw new Error('team HTTP '+r.status);await r.json();window.rerender();return true})`,
      awaitPromise: true,
      returnByValue: true,
    })
    assert.equal(result.result.value, true, 'real team read completed')
    teamReads++
    const state = await evaluate('window.readTerminal(0)')
    const tick = Number(state.lines[0].match(/^STRESS_TICK:(\d+)$/)?.[1])
    assert.ok(Number.isInteger(tick) && tick > previousTick, 'real PTY background output continues')
    previousTick = tick
    assert.equal(state.focused, true, 'background output and parent rerenders keep textarea focus')
    assert.deepEqual(state.selection, [0, 0], 'helper textarea selection stays collapsed')
    assert.equal(state.lines[1], expectedDraft, 'draft remains on its original terminal row')
    assert.deepEqual([state.x, state.y], [102, 1], 'terminal input cursor stays after the draft')
    assert.equal(
      await evaluate('window.createdCount'),
      2,
      'polling does not rebuild either terminal'
    )
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  await evaluate('window.sendFrom(0,"__STRESS_STOP__")')
  console.log(
    JSON.stringify({
      nativeEnglishCharacters: 100,
      focusAndCursorStableMs: Math.round(performance.now() - stressStarted),
      realTeamReads: teamReads,
      boundary:
        'production hook, real HTTP/WS/PTY, periodic parent renders; not full app or iPhone',
    })
  )
} catch (error) {
  failures.push(error)
} finally {
  socket?.close()
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null)
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  try {
    const results = await Promise.allSettled([server?.close(), hive?.close()])
    failures.push(
      ...results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    )
  } finally {
    if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousDataDir
  }
}
if (failures.length) throw new AggregateError(failures, 'Isolated terminal validation failed')
