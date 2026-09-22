import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const root = resolve(import.meta.dirname, '..')
const assetsDir = join(root, 'web', 'dist', 'assets')
const cssName = readdirSync(assetsDir).find((name) => /^index-.*\.css$/u.test(name))
if (!cssName) throw new Error('Build web assets first: no web/dist/assets/index-*.css found')
const css = readFileSync(join(assetsDir, cssName), 'utf8')

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
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH to run layout validation')

const reservePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No TCP port assigned'))
      server.close(() => resolvePort(address.port))
    })
  })

const waitForEndpoint = async (url) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;background:var(--bg-0);color:var(--text-primary)}main{box-sizing:border-box;margin:auto;max-width:640px;padding:24px 16px}#disabled-fixture{position:fixed;left:-9999px;top:0}</style></head><body><div id="shell" class="mobile-shell"><div class="mobile-topbar"><main class="settings-sheet" data-mobile="true"><section class="settings-section"><div class="settings-toggle-row" id="row-on"><span id="copy" class="min-w-0 flex-1 text-left"><span class="block text-sm font-medium text-pri">工作流与自动组队长中文标题</span><span class="mt-0.5 block text-xs text-ter leading-relaxed">长中文说明文字应换行，不得挤压开关。</span></span><button id="on" type="button" class="settings-switch" data-checked="true" role="switch" aria-checked="true" aria-label="工作流"><span class="settings-switch__thumb"></span></button></div><div class="settings-toggle-row"><span class="min-w-0 flex-1 text-left">远程访问</span><button id="off" type="button" class="settings-switch" role="switch" aria-checked="false" aria-label="远程访问"><span class="settings-switch__thumb"></span></button></div></section></main></div></div><div id="disabled-fixture" aria-hidden="true"><button id="disabled" type="button" class="settings-switch" role="switch" aria-checked="false" aria-label="disabled" disabled><span class="settings-switch__thumb"></span></button></div></body></html>`

const tempDir = mkdtempSync(join(tmpdir(), 'hive-switch-layout-'))
const htmlPath = join(tempDir, 'switch.html')
writeFileSync(htmlPath, html, 'utf8')
const artifactsDir = join(root, 'artifacts', 'validation')
mkdirSync(artifactsDir, { recursive: true })

const port = await reservePort()
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tempDir, 'profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true }
)

let socket
try {
  await waitForEndpoint(`http://127.0.0.1:${port}/json/version`)
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(htmlPath).href)}`,
    { method: 'PUT' }
  ).then((response) => response.json())
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.once('open', resolveOpen)
    socket.once('error', reject)
  })

  let sequence = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence
      pending.set(id, { reject, resolve: resolveCall })
      socket.send(JSON.stringify({ id, method, params }))
    })

  await call('Page.enable')
  const results = []
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 393, height: 852 },
    { width: 430, height: 932 },
    { width: 1440, height: 900 },
  ]) {
    const mobile = viewport.width < 768
    await call('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    })
    await call('Page.reload', { ignoreCache: true })
    const readyDeadline = Date.now() + 5000
    let pageReady = false
    while (Date.now() < readyDeadline) {
      const ready = await call('Runtime.evaluate', {
        returnByValue: true,
        expression:
          "document.readyState === 'complete' && (!document.fonts || document.fonts.status === 'loaded')",
      })
      if (ready.result.value) {
        pageReady = true
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    }
    if (!pageReady) throw new Error(`${viewport.width} page did not become ready`)
    await call('Runtime.evaluate', {
      expression: `document.querySelector('#shell').classList.toggle('mobile-shell', ${mobile})`,
    })
    const evaluated = await call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const rect = (selector) => {
          const node = document.querySelector(selector); const box = node.getBoundingClientRect();
          return {left: box.left, right: box.right, width: box.width, height: box.height};
        };
        const on = document.querySelector('#on'); on.focus();
        const onStyle = getComputedStyle(on); const disabledStyle = getComputedStyle(document.querySelector('#disabled'));
        return {track:rect('#on'),thumb:rect('#on .settings-switch__thumb'),row:rect('#row-on'),copy:rect('#copy'),onColor:onStyle.backgroundColor,offColor:getComputedStyle(document.querySelector('#off')).backgroundColor,focusShadow:onStyle.boxShadow,disabledOpacity:parseFloat(disabledStyle.opacity)};
      })()`,
    })
    const value = evaluated.result.value
    const expected = mobile
      ? { track: [50, 30], thumb: [26, 26] }
      : { track: [36, 20], thumb: [16, 16] }
    if (value.track.width !== expected.track[0] || value.track.height !== expected.track[1]) {
      throw new Error(`${viewport.width} track mismatch: ${JSON.stringify(value.track)}`)
    }
    if (value.thumb.width !== expected.thumb[0] || value.thumb.height !== expected.thumb[1]) {
      throw new Error(`${viewport.width} thumb mismatch: ${JSON.stringify(value.thumb)}`)
    }
    if (value.row.height < 44 || value.track.left - value.copy.right < 11.9) {
      throw new Error(`${viewport.width} touch target/gap regression: ${JSON.stringify(value)}`)
    }
    if (value.onColor === value.offColor || value.focusShadow === 'none') {
      throw new Error(`${viewport.width} state/focus regression: ${JSON.stringify(value)}`)
    }
    if (value.disabledOpacity >= 1)
      throw new Error(`${viewport.width} disabled state is not visible`)
    const screenshot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const screenshotPath = join(
      artifactsDir,
      `settings-switch-${viewport.width}x${viewport.height}.png`
    )
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    results.push({ viewport, ...value, screenshotPath })
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  socket?.close()
  chrome.kill()
  await Promise.race([
    once(chrome, 'exit'),
    new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
  ])
  rmSync(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
}
