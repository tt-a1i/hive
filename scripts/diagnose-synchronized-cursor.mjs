// Isolated browser experiment; does not connect to Hive or touch agent sessions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import WebSocket from 'ws'

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)
if (!chromePath) throw new Error('Chrome required')
const useWebgl = process.argv.includes('--webgl')
const anchorCandidate = process.argv.includes('--anchor-candidate')
const composing = process.argv.includes('--composition')
const hiveBridge = process.argv.includes('--hive-bridge')
const startDuringSync = process.argv.includes('--start-during-sync')
const boundaries = process.argv.includes('--boundaries')
const sourceCandidate = process.env.HIVE_DIAGNOSTIC_XTERM_MODULE
let server
let chrome
let socket
try {
  server = await createServer({
    configFile: false,
    root: resolve(import.meta.dirname, '..'),
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { include: ['@xterm/xterm'] },
  })
  server.middlewares.use('/cursor-probe', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css"><div id="terminal"></div><script type="module">
import { Terminal } from '${sourceCandidate ? '/xterm-source-candidate' : '/node_modules/@xterm/xterm/lib/xterm.mjs'}';
const terminal = new Terminal({cols:40, rows:10, allowProposedApi:true});
terminal.open(document.getElementById('terminal')); terminal.focus();
const sent=[]; let isComposing=false;
${
  hiveBridge
    ? `const { attachCompositionBridge } = await import('/web/src/terminal/composition.ts');
const bridge=attachCompositionBridge(terminal.textarea,{
setComposing:value=>{isComposing=value;},commit:text=>sent.push(text),input:text=>terminal.input(text,true)});
terminal.onData(text=>{const filtered=bridge.filterData(text);if(filtered)sent.push(filtered);});`
    : ''
}
${
  anchorCandidate
    ? `// Diagnostic-only interception; not a proposed production private-API adapter.
const originalSync = terminal._core._syncTextArea.bind(terminal._core);
terminal._core._syncTextArea = () => { if (!terminal.modes.synchronizedOutputMode) originalSync(); };
terminal.onRender(() => terminal._core._syncTextArea());
const helper=terminal._core._compositionHelper;
const originalUpdate=helper.updateCompositionElements.bind(helper);
helper.updateCompositionElements=(...args)=>{if(!terminal.modes.synchronizedOutputMode) originalUpdate(...args);};`
    : ''
}
${useWebgl ? "const { WebglAddon } = await import('/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'); terminal.loadAddon(new WebglAddon());" : ''}
const paint = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const write = data => new Promise(r=>terminal.write(data,r));
let paints=0; terminal.onRender(()=>paints++);
const state = () => ({x:terminal.buffer.active.cursorX,y:terminal.buffer.active.cursorY,
 left:terminal.textarea.style.left,top:terminal.textarea.style.top,paints,
 focused:document.activeElement===terminal.textarea,sync:terminal.modes.synchronizedOutputMode,
 helperOpacity:getComputedStyle(terminal.textarea).opacity,
 compositionTop:terminal.element.querySelector('.composition-view').style.top});
window.probe = async (step) => {
 const writes=['\\x1b[8;1H> abc123','\\x1b[?2026h\\x1b[2;1HWorking','\\x1b[8;9H\\x1b[?2026l'];
 await write(writes[step]);
 ${
   composing
     ? `if(step===${startDuringSync ? 1 : 0}) terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 if(step>=${startDuringSync ? 1 : 0}) {
 terminal.textarea.value='测试';
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'测试'})); }`
     : ''
 }
 await paint(); return state();
};
window.finish = async () => {
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'测试'}));
 terminal.textarea.value='测试';
 terminal.textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromComposition',data:'测试'}));
 for (const data of ['a','/']) {
  terminal.textarea.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Unidentified',keyCode:229}));
  terminal.textarea.value=data;
  terminal.textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data}));
 }
 await paint();return {sent:[...sent],isComposing,focused:document.activeElement===terminal.textarea};
};
window.boundaries = async () => {
 sent.length=0;
 await write('\\x1b[8;9H');await paint();
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 terminal.textarea.value='测试';
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'测试'}));
 await write('\\x1b[?2026h\\x1b[2;1HWorking');
 const input=await window.finish();
 const during=state();
 // Wait for xterm's own timeout/render event; deadline is a failure bound only.
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{subscription.dispose();reject(new Error('xterm timeout did not render'));},2000);
  const subscription=terminal._core._renderService.onRender(()=>{if(!terminal.modes.synchronizedOutputMode){clearTimeout(timer);subscription.dispose();resolve();}});
 });
 await paint(); const released=state();
 terminal.resize(32,12);await paint();const resized=state();
 await write('\\x1b[8;9H');await paint();
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 terminal.textarea.value='测试';
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'测试'}));
 await paint();const geometryBefore=state();
 await write('\\x1b[?2026h\\x1b[2;1HWorking');
 terminal.options.fontSize=22;
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'测试'}));
 await paint();const geometryDuring=state();
 await write('\\x1b[8;9H\\x1b[?2026l');await paint();const geometryAfter=state();
 const expectedTop=7*terminal._core._renderService.dimensions.css.cell.height+'px';
 await window.finish();
 await write(('line\\r\\n').repeat(30)+'\\x1b[2;3H');await paint();
 terminal.scrollLines(-1);await paint();
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 terminal.textarea.value='测试';
 terminal.textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'测试'}));
 await paint();const scrolled=state();
 const b=terminal.buffer.active;
 const scrollExpectedTop=(b.baseY+b.cursorY-b.viewportY)*terminal._core._renderService.dimensions.css.cell.height+'px';
 return {input,during,released,resized,geometryBefore,geometryDuring,geometryAfter,expectedTop,scrolled,scrollExpectedTop,scrollOffset:b.baseY-b.viewportY};
}; window.ready=true;
</script>`)
  })
  // Serve this diagnostic route before Vite's HTML fallback middleware.
  server.middlewares.stack.unshift(server.middlewares.stack.pop())
  if (sourceCandidate) {
    const candidateBytes = readFileSync(sourceCandidate)
    server.middlewares.use('/xterm-source-candidate', (_request, response) => {
      response.setHeader('content-type', 'text/javascript; charset=utf-8')
      response.end(candidateBytes)
    })
    server.middlewares.stack.unshift(server.middlewares.stack.pop())
  }
  await server.listen()
  const profileDir = mkdtempSync(join(tmpdir(), 'hive-sync-cursor-'))
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
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
    const message = JSON.parse(raw.toString())
    if (message.method === 'Runtime.exceptionThrown') console.log(JSON.stringify(message.params))
    const task = pending.get(message.id)
    if (!task) return
    clearTimeout(task.timer)
    pending.delete(message.id)
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => {
        pending.delete(n)
        reject(new Error(`${method} timeout`))
      }, 10000)
      pending.set(n, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: n, method, params }))
    })
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.navigate', {
    url: `http://127.0.0.1:${server.httpServer.address().port}/cursor-probe`,
  })
  for (let i = 0; i < 100; i++) {
    if (
      (await call('Runtime.evaluate', { expression: 'window.ready', returnByValue: true })).result
        .value
    )
      break
    if (i === 99) throw new Error('Probe not ready')
    await new Promise((r) => setTimeout(r, 50))
  }
  const result = {
    renderer: useWebgl ? 'webgl' : 'dom',
    anchorCandidate,
    composing,
    hiveBridge,
    sourceCandidate: Boolean(sourceCandidate),
    startDuringSync,
  }
  for (const [step, name] of ['before', 'during', 'after'].entries()) {
    const reply = await call('Runtime.evaluate', {
      expression: `window.probe(${step})`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (reply.exceptionDetails) throw new Error('Browser probe failed')
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    result[name] = {
      ...reply.result.value,
      screenshotHash: createHash('sha256').update(shot.data).digest('hex'),
    }
  }
  if (hiveBridge && composing) {
    const reply = await call('Runtime.evaluate', {
      expression: 'window.finish()',
      awaitPromise: true,
      returnByValue: true,
    })
    if (reply.exceptionDetails) throw new Error('Composition completion failed')
    result.input = reply.result.value
    assert.deepEqual(result.input.sent, ['测试', 'a', '/'])
    assert.equal(result.input.isComposing, false)
    assert.equal(result.input.focused, true)
  }
  console.log(JSON.stringify(result))
  assert.equal(result.during.sync, true)
  assert.equal(result.during.paints, result.before.paints, 'grid painting is suspended')
  assert.equal(result.during.focused, true)
  assert.equal(result.after.top, result.before.top, 'textarea returns after repaint')
  if (startDuringSync)
    assert.equal(
      result.during.compositionTop,
      result.before.top,
      'composition starting during sync must anchor to the visible cursor'
    )
  else
    assert.equal(
      result.during.screenshotHash,
      result.before.screenshotHash,
      'visible screen changed during synchronized update'
    )
  // Red-capable hypothesis: the input anchor should stay with the visible grid.
  assert.equal(
    result.during.top,
    result.before.top,
    'input anchor moved while the visible grid was frozen'
  )
  if (boundaries) {
    const reply = await call('Runtime.evaluate', {
      expression: 'window.boundaries()',
      awaitPromise: true,
      returnByValue: true,
    })
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
    const details = reply.result.value
    console.log(JSON.stringify({ boundaries: details }))
    assert.deepEqual(details.input.sent, ['测试', 'a', '/'])
    assert.equal(details.input.isComposing, false)
    assert.equal(details.during.top, result.before.top)
    assert.equal(details.released.sync, false)
    assert.equal(
      details.released.top,
      '15px',
      'timeout render must release textarea to displayed row'
    )
    assert.equal(details.released.focused, true)
    assert.equal(details.resized.focused, true)
    assert.equal(
      details.geometryDuring.top,
      details.geometryBefore.top,
      'font change during sync must not mix old grid with new cell geometry'
    )
    assert.equal(details.geometryAfter.top, details.expectedTop)
    assert.equal(details.scrollOffset, 1)
    assert.equal(details.scrolled.compositionTop, details.scrollExpectedTop)
    assert.equal(details.scrolled.top, details.scrollExpectedTop)
  }
} finally {
  socket?.close()
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) chrome.kill()
  await server?.close()
}
