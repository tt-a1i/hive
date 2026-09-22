// Real PTY boundary experiment with deterministic synthetic output; no Hive sessions.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import pty from '@lydell/node-pty'
import headless from '@xterm/headless'

const modulePath = process.argv.find((arg) => arg.startsWith('--pty-module='))?.slice(13)
const ptyModule = modulePath ? (await import(pathToFileURL(modulePath).href)).default : pty

const frames = 12
const esc = '\x1b'
const hiveOptions = process.argv.includes('--hive')
  ? (await import('../src/server/agent-manager.ts')).buildAgentPtySpawnOptions(process.cwd(), {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
    })
  : undefined
const source = `let i=0;const timer=setInterval(()=>{const row=8+i%2;process.stdout.write(${JSON.stringify(esc + '[?2026h' + esc + '[?25l' + esc + '[2;1HWorking')}+i+${JSON.stringify(esc + '[')}+row+';13H'+${JSON.stringify(esc + '[?25h' + esc + '[?2026l')});if(++i===${frames}){clearInterval(timer);setTimeout(()=>process.exit(0),300)}},100)`

const backends = hiveOptions
  ? [hiveOptions.useConptyDll ?? false]
  : process.argv.includes('--dll')
    ? [true]
    : process.argv.includes('--system')
      ? [false]
      : [false, true]
for (const useConptyDll of backends) {
  const started = performance.now()
  let firstPaintMs
  const terminal = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true })
  const endings = []
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(2026))
      endings.push({
        x: terminal.buffer.active.cursorX,
        y: terminal.buffer.active.cursorY,
        hidden: terminal._core.coreService.isCursorHidden,
      })
    return false
  })
  const child = ptyModule.spawn(process.execPath, ['-e', source], {
    ...hiveOptions,
    cols: 40,
    rows: 12,
    name: 'xterm-256color',
    cwd: process.cwd(),
    useConptyDll,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TERM: 'xterm-256color',
    },
  })
  if (process.argv.includes('--respond')) terminal.onData((data) => child.write(data))
  let writes = Promise.resolve()
  let chunks = 0
  let controls = ''
  child.onData((data) => {
    if (firstPaintMs === undefined && data.includes('Working'))
      firstPaintMs = performance.now() - started
    chunks++
    controls += data
    writes = writes.then(() => new Promise((resolve) => terminal.write(data, resolve)))
  })
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('PTY diagnostic timeout'))
      }, 10000)
      child.onExit((event) => {
        clearTimeout(timeout)
        resolve(event.exitCode)
      })
    })
    await writes
    const expected = Array.from({ length: frames }, (_, i) => ({
      x: 12,
      y: 7 + (i % 2),
      hidden: false,
    }))
    const mismatches = endings
      .map((actual, i) => ({ frame: i, actual, expected: expected[i] }))
      .filter((e) => JSON.stringify(e.actual) !== JSON.stringify(e.expected))
    console.log(
      JSON.stringify({
        useConptyDll,
        firstPaintMs,
        exitCode,
        chunks,
        endings: endings.length,
        mismatches,
        finalCursor: { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY },
        // biome-ignore lint/suspicious/noControlCharactersInRegex: This probe measures ANSI control ordering, not user text.
        controlTokens: [...controls.matchAll(/\x1b\[([?0-9;]*)([A-Za-z])/g)]
          .slice(0, 24)
          .map((m) => m[1] + m[2]),
      })
    )
    assert.equal(exitCode, 0)
    assert.equal(endings.length, frames, 'all application sync ends must be observed')
    // Do not abort the second backend comparison when the first differs.
    if (mismatches.length) process.exitCode = 1
  } finally {
    terminal.dispose()
    if (process.argv.includes('--kill-after-exit')) child.kill()
  }
  // Flush close callbacks queued with the exit event; do not let an unref'ed
  // diagnostic timer silently disappear before the lifecycle check executes.
  await new Promise((resolve) => setImmediate(resolve))
  const lifecycle = {
    useConptyDll,
    workerDisposed: child._agent?._conoutSocketWorker?._isDisposed,
    inputDestroyed: child._agent?._inSocket?.destroyed,
    outputDestroyed: child._agent?._outSocket?.destroyed,
  }
  console.log(JSON.stringify({ lifecycle }))
  assert.equal(lifecycle.workerDisposed, true, 'PTY output worker must be disposed')
  assert.equal(lifecycle.inputDestroyed, true, 'PTY input pipe must be closed')
  assert.equal(lifecycle.outputDestroyed, true, 'PTY output pipe must be closed')
}
