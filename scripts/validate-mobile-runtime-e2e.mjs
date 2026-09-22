import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import WebSocket from 'ws'

const root = resolve(import.meta.dirname, '..')
const runtimeModule = join(root, 'dist', 'src', 'cli', 'hive.js')
if (!existsSync(runtimeModule)) throw new Error('Build Hive first: dist/src/cli/hive.js is missing')

const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES &&
    join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] &&
    join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH to run mobile runtime E2E')

const reservePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('No TCP port assigned'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })

const waitForEndpoint = async (url) => {
  const deadline = Date.now() + 10000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError })
}

const dataRoot = mkdtempSync(join(tmpdir(), 'hive-mobile-runtime-e2e-'))
const workspacePath = join(dataRoot, 'workspace')
const profilePath = join(dataRoot, 'chrome-profile')
const artifactsDir = join(root, 'artifacts', 'validation')
mkdirSync(join(workspacePath, '.hive'), { recursive: true })
mkdirSync(artifactsDir, { recursive: true })

const taskContent =
  '# E2E 任务 🚀\n\n- [ ] 中文，English 😀 `code` [链接](https://example.com/路径)\n'
writeFileSync(join(workspacePath, '.hive', 'tasks.md'), taskContent, 'utf8')

const terminalText = '边界中文😀，English `code`'
const workerTexts = [
  'Worker 一号历史：中文😀，English `code`',
  'Worker 二号历史：切换正常🧩，Markdown **bold**',
]
const outputScript = join(workspacePath, 'utf8-split-output.js')
writeFileSync(
  outputScript,
  [
    `const text = process.argv[2] || ${JSON.stringify(terminalText)}`,
    "const bytes = Buffer.from(text, 'utf8')",
    'let offset = 0',
    'const timer = setInterval(() => {',
    '  process.stdout.write(bytes.subarray(offset, offset + 1))',
    '  offset += 1',
    "  if (offset === bytes.length) { clearInterval(timer); process.stdout.write('\\n') }",
    '}, 8)',
    "process.stdin.on('data', (chunk) => process.stdout.write('ECHO:' + chunk))",
    'process.stdin.resume()',
    'setInterval(() => {}, 1000)',
  ].join('\n'),
  'utf8'
)

const originalDataDir = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = join(dataRoot, 'runtime')
const { runHiveCommand } = await import(pathToFileURL(runtimeModule).href)
const hive = await runHiveCommand(['--port', '0'], {
  versionService: { getVersionInfo: async () => ({ update_available: false }) },
})
const baseUrl = `http://127.0.0.1:${hive.port}`

let chrome
let socket
let testError
let workspaceIdForCleanup
let shellRunIdForCleanup
try {
  const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
  const cookie = sessionResponse.headers.get('set-cookie')
  if (!cookie) throw new Error('Runtime did not issue a UI session cookie')
  const requestHeaders = { cookie }

  const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { ...requestHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: '移动端 E2E',
      path: workspacePath,
    }),
  })
  if (createResponse.status !== 201) {
    throw new Error(
      `Workspace creation failed: ${createResponse.status} ${await createResponse.text()}`
    )
  }
  const workspace = await createResponse.json()
  workspaceIdForCleanup = workspace.id

  const workers = []
  for (const [index, workerText] of workerTexts.entries()) {
    const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { ...requestHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `E2E Worker ${index + 1}`, role: 'coder' }),
    })
    if (workerResponse.status !== 201) {
      throw new Error(
        `Worker ${index + 1} creation failed: ${workerResponse.status} ${await workerResponse.text()}`
      )
    }
    const worker = await workerResponse.json()
    const configResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { ...requestHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ command: process.execPath, args: [outputScript, workerText] }),
      }
    )
    if (configResponse.status !== 204) {
      throw new Error(`Worker ${index + 1} config failed: ${configResponse.status}`)
    }
    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      {
        method: 'POST',
        headers: { ...requestHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      }
    )
    if (startResponse.status !== 201) {
      throw new Error(
        `Worker ${index + 1} start failed: ${startResponse.status} ${await startResponse.text()}`
      )
    }
    const started = await startResponse.json()
    workers.push({ ...worker, runId: started.run_id, text: workerText })
  }

  const activeResponse = await fetch(`${baseUrl}/api/settings/app-state/active_workspace_id`, {
    method: 'PUT',
    headers: { ...requestHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ value: workspace.id }),
  })
  if (!activeResponse.ok) throw new Error(`Active workspace save failed: ${activeResponse.status}`)

  const debuggingPort = await reservePort()
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-first-run',
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profilePath}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  await waitForEndpoint(`http://127.0.0.1:${debuggingPort}/json/version`)
  const target = await fetch(
    `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' }
  ).then((response) => response.json())
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.once('open', resolveOpen)
    socket.once('error', reject)
  })

  let sequence = 0
  const pending = new Map()
  const browserWsFrames = []
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.method === 'Network.webSocketFrameReceived') {
      browserWsFrames.push({ direction: 'received', ...message.params.response })
      return
    }
    if (message.method === 'Network.webSocketFrameSent') {
      browserWsFrames.push({ direction: 'sent', ...message.params.response })
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        const detail =
          method === 'Runtime.evaluate' && typeof params.expression === 'string'
            ? `: ${params.expression.slice(0, 240)}`
            : ''
        reject(new Error(`CDP ${method} timed out after 20s${detail}`))
      }, 20000)
      pending.set(id, { reject, resolve: resolveCall, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? 'Browser evaluation failed'
      )
    }
    return response.result.value
  }
  const waitForValue = async (description, expression, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    let value
    while (Date.now() < deadline) {
      value = await evaluate(expression)
      if (value) return value
      await new Promise((resolveWait) => setTimeout(resolveWait, 40))
    }
    throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(value)}`)
  }
  const waitForLocal = async (description, readValue, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    let value
    while (Date.now() < deadline) {
      value = readValue()
      if (value) return value
      await new Promise((resolveWait) => setTimeout(resolveWait, 40))
    }
    throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(value)}`)
  }
  const frameTextSince = (direction, startIndex) =>
    browserWsFrames
      .slice(startIndex)
      .filter((frame) => frame.direction === direction && frame.opcode === 1)
      .map((frame) => {
        const event = JSON.parse(frame.payloadData)
        if (event.type === 'input' || event.type === 'output') return event.data
        if (event.type === 'restore') return event.snapshot
        return ''
      })
      .join('')
  const screenshot = async (name) => {
    const captured = await call('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
    })
    const screenshotPath = join(artifactsDir, name)
    writeFileSync(screenshotPath, Buffer.from(captured.data, 'base64'))
    return screenshotPath
  }

  await call('Page.enable')
  await call('Network.enable')
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  })
  const [cookieName, cookieValue] = cookie.split(';', 1)[0].split('=')
  await call('Network.setCookie', { name: cookieName, value: cookieValue, url: baseUrl })
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('hive.uiLanguage', 'zh');
      localStorage.setItem('hive.first-run-seen', 'true');
      localStorage.setItem('hive.last-seen-version', '2.2.1');
    } catch (error) { console.error(error); }`,
  })
  await call('Page.navigate', { url: baseUrl })
  await waitForValue(
    'mobile app shell',
    "document.querySelector('[data-testid=mobile-bottom-nav]') && document.body.textContent.includes('移动端 E2E')"
  )
  await evaluate("document.querySelector('[data-testid=mobile-team-tab-workers]').click()")
  for (const worker of workers) {
    await waitForValue(
      `worker card ${worker.id}`,
      `Boolean(document.querySelector(${JSON.stringify(`[data-testid="worker-card-${worker.id}"]`)}))`
    )
  }

  const openWorkerAndVerifyRestore = async (worker, label, expectRestore = true) => {
    const frameStart = browserWsFrames.length
    await evaluate(
      `document.querySelector(${JSON.stringify(`[data-testid="worker-card-${worker.id}"]`)}).click()`
    )
    await waitForValue(
      `${label} worker modal terminal`,
      `Boolean(document.querySelector('[data-testid=worker-modal] .xterm-helper-textarea'))`,
      15000
    )
    if (expectRestore) {
      await waitForLocal(
        `${label} worker UTF-8 restore`,
        () => frameTextSince('received', frameStart).includes(worker.text),
        15000
      )
      const restored = frameTextSince('received', frameStart)
      if (restored.includes('\uFFFD') || /(?:Ã|Â|ƒ)/u.test(restored)) {
        throw new Error(`${label} worker restore contains mojibake markers`)
      }
    }
  }
  const closeWorker = async () => {
    await evaluate("document.querySelector('[data-testid=worker-modal-close]').click()")
    await waitForValue(
      'worker modal close',
      "!document.querySelector('[data-testid=worker-modal]')"
    )
  }

  await openWorkerAndVerifyRestore(workers[0], 'initial')
  await evaluate(
    `document.querySelector('[data-testid=worker-modal] [data-terminal-host-run-id=${JSON.stringify(workers[0].runId)}]').dataset.e2eReopenIdentity = 'worker-one'`
  )
  const workerLiveText = '实时输出：新鲜中文🎉，English'
  const workerLiveFrameStart = browserWsFrames.length
  hive.store.writeRunInput(workers[0].runId, workerLiveText)
  await waitForLocal(
    'worker live UTF-8 output',
    () => frameTextSince('received', workerLiveFrameStart).includes(workerLiveText),
    15000
  )
  if (frameTextSince('received', workerLiveFrameStart).includes('\uFFFD')) {
    throw new Error('Worker live output contains U+FFFD')
  }
  const workerScreenshot = await screenshot('mobile-runtime-worker-390x844.png')
  await closeWorker()
  await openWorkerAndVerifyRestore(workers[0], 'reopened', false)
  await waitForValue(
    'reopened worker reuses the verified terminal host',
    `document.querySelector('[data-testid=worker-modal] [data-e2e-reopen-identity="worker-one"]')?.dataset.terminalHostParked === 'false'`
  )
  await closeWorker()
  await openWorkerAndVerifyRestore(workers[1], 'switched')
  await closeWorker()

  await call('Page.reload', { ignoreCache: true })
  await waitForValue(
    'reloaded document readiness',
    `document.readyState === 'complete' &&
      performance.getEntriesByType('navigation')[0]?.type === 'reload'`
  )
  await waitForValue(
    'activate Workers after refresh',
    `(() => {
      const tab = document.querySelector('[data-testid=mobile-team-tab-workers]');
      if (!tab) return false;
      tab.click();
      return true;
    })()`
  )
  await waitForValue(
    'first worker card after refresh',
    `Boolean(document.querySelector(${JSON.stringify(`[data-testid="worker-card-${workers[0].id}"]`)}))`
  )
  await openWorkerAndVerifyRestore(workers[0], 'refreshed')
  await closeWorker()

  await waitForValue(
    'workspace shell button',
    "Boolean(document.querySelector('[data-testid=open-workspace-shell]'))"
  )
  await evaluate("document.querySelector('[data-testid=open-workspace-shell]').click()")
  const terminalTestId = await waitForValue(
    'terminal helper textarea',
    `(() => {
      const textarea = document.querySelector('[data-testid=terminal-bottom-panel] .xterm-helper-textarea');
      return textarea?.closest('[data-testid^="terminal-"]')?.getAttribute('data-testid') ?? '';
    })()`,
    15000
  )
  const shellRuns = hive.store
    .listTerminalRuns(workspace.id)
    .filter((run) => run.agent_name === 'Shell')
  const shellRunId = shellRuns.at(-1)?.run_id
  if (!shellRunId) {
    throw new Error(
      `UI mounted ${terminalTestId}, but runtime has no Shell run: ${JSON.stringify(shellRuns)}`
    )
  }
  shellRunIdForCleanup = shellRunId
  const liveFrameStart = browserWsFrames.length
  hive.store.writeRunInput(shellRunId, `node "${outputScript}"\r`)
  await waitForLocal('live UTF-8 terminal output', () =>
    frameTextSince('received', liveFrameStart).includes(terminalText)
  )
  const liveTerminalText = frameTextSince('received', liveFrameStart)
  if (liveTerminalText.includes('\uFFFD')) throw new Error('Live terminal output contains U+FFFD')
  await waitForValue(
    'xterm canvas renderer',
    "Boolean(document.querySelector('[data-testid=terminal-bottom-panel] canvas'))"
  )

  await evaluate(
    `document.querySelector('[data-testid=terminal-bottom-panel] .xterm-helper-textarea').focus()`
  )
  const slashFrameStart = browserWsFrames.length
  const slashStartedAt = performance.now()
  await call('Input.insertText', { text: '/' })
  await waitForLocal(
    'slash WebSocket send and PTY echo',
    () =>
      frameTextSince('sent', slashFrameStart).includes('/') &&
      frameTextSince('received', slashFrameStart).includes('/')
  )
  const slashLatencyMs = performance.now() - slashStartedAt

  const englishFrameStart = browserWsFrames.length
  const englishStartedAt = performance.now()
  await call('Input.insertText', { text: 'abc' })
  await waitForLocal(
    'English WebSocket send and PTY echo',
    () =>
      frameTextSince('sent', englishFrameStart).includes('abc') &&
      frameTextSince('received', englishFrameStart).includes('abc')
  )
  const englishLatencyMs = performance.now() - englishStartedAt

  const imeFrameStart = browserWsFrames.length
  await call('Input.imeSetComposition', {
    text: '输入测',
    selectionStart: 3,
    selectionEnd: 3,
    replacementStart: 0,
    replacementEnd: 0,
  })
  const imeStartedAt = performance.now()
  await call('Input.insertText', { text: '输入测' })
  await waitForLocal(
    'IME WebSocket send and PTY echo',
    () =>
      frameTextSince('sent', imeFrameStart).includes('输入测') &&
      frameTextSince('received', imeFrameStart).includes('输入测')
  )
  const imeLatencyMs = performance.now() - imeStartedAt
  const imeSentText = frameTextSince('sent', imeFrameStart)
  if (imeSentText.split('输入测').length - 1 !== 1)
    throw new Error('IME composition was committed more than once')

  const backspaceFrameStart = browserWsFrames.length
  await call('Input.insertText', { text: 'z' })
  await waitForLocal('text before backspace', () =>
    frameTextSince('sent', backspaceFrameStart).includes('z')
  )
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  })
  await waitForLocal('backspace WebSocket send', () =>
    frameTextSince('sent', backspaceFrameStart).includes('\u007f')
  )
  const terminalScreenshot = await screenshot('mobile-runtime-terminal-390x844.png')

  await evaluate("document.querySelector('[data-testid=mobile-nav-tasks]').click()")
  await waitForValue(
    'mixed Unicode Tasks render',
    `document.querySelector('[data-testid=task-graph-content]')?.textContent.includes('中文，English') && document.querySelector('[data-testid=task-graph-content]')?.textContent.includes('😀')`
  )
  const renderedTasks = await evaluate(
    "document.querySelector('[data-testid=task-graph-content]')?.textContent ?? ''"
  )
  if (/[\uFFFD]|Ã|Â/u.test(renderedTasks)) throw new Error('Tasks page contains mojibake markers')
  const tasksScreenshot = await screenshot('mobile-runtime-tasks-390x844.png')

  await evaluate("document.querySelector('[data-testid=topbar-app-settings]').click()")
  await waitForValue(
    'settings dialog',
    "Boolean(document.querySelector('[data-testid=app-settings-menu]'))"
  )
  const mobileSettings = await evaluate(`(() => {
    const menu = document.querySelector('[data-testid=app-settings-menu]');
    const remote = menu.querySelector('[data-testid=remote-access-section]');
    const switches = [...menu.querySelectorAll('[role=switch]')];
    const remoteSwitches = [...remote.querySelectorAll('[role=switch]')];
    const track = document.querySelector('[data-testid=settings-toggle-remote]');
    const thumb = track.querySelector('.settings-switch__thumb');
    const row = track.closest('.settings-toggle-row');
    const box = (node) => { const r = node.getBoundingClientRect(); return { width:r.width, height:r.height, left:r.left, right:r.right }; };
    return { switchCount:switches.length, remoteSwitchCount:remoteSwitches.length, track:box(track), thumb:box(thumb), row:box(row) };
  })()`)
  if (mobileSettings.remoteSwitchCount !== 1) {
    throw new Error(
      `Production Remote access rendered ${mobileSettings.remoteSwitchCount} switches`
    )
  }
  if (
    mobileSettings.track.width !== 50 ||
    mobileSettings.track.height !== 30 ||
    mobileSettings.thumb.width !== 26 ||
    mobileSettings.thumb.height !== 26 ||
    mobileSettings.row.height < 44
  ) {
    throw new Error(`Mobile settings geometry mismatch: ${JSON.stringify(mobileSettings)}`)
  }
  const settings390Screenshot = await screenshot('mobile-runtime-settings-390x844.png')

  await call('Emulation.setDeviceMetricsOverride', {
    width: 393,
    height: 852,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 393,
    screenHeight: 852,
  })
  const settings393Screenshot = await screenshot('mobile-runtime-settings-393x852.png')

  await call('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 932,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 430,
    screenHeight: 932,
  })
  const settings430 = await evaluate(`(() => {
    const track = document.querySelector('[data-testid=settings-toggle-remote]');
    const thumb = track.querySelector('.settings-switch__thumb');
    const row = track.closest('.settings-toggle-row');
    const box = (node) => { const r = node.getBoundingClientRect(); return { width:r.width, height:r.height, left:r.left, right:r.right }; };
    return { track:box(track), thumb:box(thumb), row:box(row) };
  })()`)
  if (
    settings430.track.width !== 50 ||
    settings430.track.height !== 30 ||
    settings430.thumb.width !== 26 ||
    settings430.thumb.height !== 26 ||
    settings430.row.height < 44
  ) {
    throw new Error(`430px mobile settings geometry mismatch: ${JSON.stringify(settings430)}`)
  }
  const settings430Screenshot = await screenshot('mobile-runtime-settings-430x932.png')

  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 900,
  })
  await call('Emulation.resetPageScaleFactor')
  await waitForValue(
    'desktop settings trigger',
    "Boolean(document.querySelector('[data-testid=topbar-app-settings]'))"
  )
  await evaluate("document.querySelector('[data-testid=topbar-app-settings]').click()")
  await waitForValue(
    'desktop settings dialog',
    "Boolean(document.querySelector('[data-testid=app-settings-menu]'))"
  )
  const desktopSettings = await evaluate(`(() => {
    const remote = document.querySelector('[data-testid=remote-access-section]');
    const track = document.querySelector('[data-testid=settings-toggle-remote]');
    const thumb = track.querySelector('.settings-switch__thumb');
    const size = (node) => { const style = getComputedStyle(node); return { width:parseFloat(style.width), height:parseFloat(style.height) }; };
    return { remoteSwitchCount:remote.querySelectorAll('[role=switch]').length, track:size(track), thumb:size(thumb) };
  })()`)
  if (
    desktopSettings.remoteSwitchCount !== 1 ||
    desktopSettings.track.width !== 36 ||
    desktopSettings.track.height !== 20 ||
    desktopSettings.thumb.width !== 16 ||
    desktopSettings.thumb.height !== 16
  ) {
    throw new Error(`Desktop settings regression: ${JSON.stringify(desktopSettings)}`)
  }
  const desktopScreenshot = await screenshot('desktop-runtime-settings-1440x900.png')

  console.log(
    JSON.stringify(
      {
        baseUrl,
        workspaceId: workspace.id,
        runId: shellRunId,
        terminalTestId,
        terminal: {
          workerModalLiveUnicode: true,
          workerModalRestoreUnicode: true,
          workerModalReopen: true,
          workerModalRefresh: true,
          workerModalSwitch: true,
          liveUnicode: true,
          restoredUnicode: true,
          slashLatencyMs,
          englishLatencyMs,
          imeLatencyMs,
          singleImeCommit: true,
          backspace: true,
        },
        tasks: { mixedUnicodeRendered: true },
        settings: { mobile: mobileSettings, mobile430: settings430, desktop: desktopSettings },
        screenshots: [
          workerScreenshot,
          terminalScreenshot,
          tasksScreenshot,
          settings390Screenshot,
          settings393Screenshot,
          settings430Screenshot,
          desktopScreenshot,
        ],
      },
      null,
      2
    )
  )
} catch (error) {
  testError = error
  throw error
} finally {
  let cleanupError
  socket?.close()
  if (chrome) {
    if (chrome.exitCode === null && process.platform === 'win32') {
      const stopped = spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (stopped.status !== 0 && chrome.exitCode === null) chrome.kill()
    } else if (chrome.exitCode === null) {
      chrome.kill('SIGTERM')
    }
    await Promise.race([
      once(chrome, 'exit'),
      new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
    ])
  }
  if (workspaceIdForCleanup && shellRunIdForCleanup) {
    hive.store.closeWorkspaceShell(workspaceIdForCleanup, shellRunIdForCleanup)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  await hive.close()
  if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
  else process.env.HIVE_DATA_DIR = originalDataDir
  try {
    rmSync(dataRoot, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 })
  } catch (error) {
    cleanupError ??= error
  }
  if (cleanupError) {
    if (!testError) process.exitCode = 1
    console.error(`E2E cleanup also failed: ${String(cleanupError)}`)
  }
}
