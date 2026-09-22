// @vitest-environment jsdom
//
// VULN-RELIABILITY-2 — the terminal stream must surface a tunnel reconnect so the caller can remount
// and take a FRESH snapshot, instead of silently reusing a dead MuxSocket (a frozen, zombie pane).
//
// The crypto/protocol aren't involved here: we drive createTerminalClient against a fake ApiTransport
// whose openWebSocket() hands back sockets we control. The product wires onclose on BOTH the io and
// control sockets; when the tunnel's resetAll() fires _remoteClose on them, the client must invoke its
// onClose() exactly once. Today terminal-client.ts never sets onclose, so the signal is lost and the
// pane freezes — every assert below FAILS before the wiring lands.

import { afterEach, describe, expect, test } from 'vitest'

import { setApiTransport } from '../../web/src/api.js'
import { createTerminalClient } from '../../web/src/terminal/terminal-client.js'
import type { ApiTransport, TransportSocket } from '../../web/src/transport/api-transport.js'

// A controllable socket matching the mux's MuxSocket shape: the test fires onmessage/onclose and the
// client sends through it. close()/_remoteClose both transition to readyState 3 and fire onclose.
class FakeSocket implements TransportSocket {
  readonly OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBufferLike | Uint8Array }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = []
  readonly path: string

  constructor(path: string) {
    this.path = path
    queueMicrotask(() => this.onopen?.())
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(reason === undefined ? { code: code ?? 1000 } : { code: code ?? 1000, reason })
  }

  // mirrors frame-mux MuxSocket._remoteClose (what resetAll('transient') drives on a tunnel drop)
  remoteClose(code: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(reason === undefined ? { code } : { code, reason })
  }

  deliver(data: string): void {
    this.onmessage?.({ data })
  }
}

interface FakeTransport extends ApiTransport {
  sockets: FakeSocket[]
}

const makeFakeTransport = (): FakeTransport => {
  const sockets: FakeSocket[] = []
  return {
    sockets,
    fetch: () => Promise.reject(new Error('not used')),
    openWebSocket: (path: string): TransportSocket => {
      const s = new FakeSocket(path)
      sockets.push(s)
      return s
    },
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  // leave the module-level transport in a sane state for other suites
  setApiTransport({
    fetch: () => Promise.reject(new Error('reset')),
    openWebSocket: () => {
      throw new Error('reset')
    },
  })
})

describe('terminal-client — tunnel reconnect surfacing (VULN-RELIABILITY-2)', () => {
  test('waits for the restore write to finish before releasing live output', async () => {
    const transport = makeFakeTransport()
    setApiTransport(transport)

    const restoreCompletion: { complete?: () => void } = {}
    let restored: string | null = null
    const output: string[] = []
    const client = createTerminalClient({
      runId: 'r-restore-backpressure',
      onError: () => {},
      onExit: () => {},
      onOutput: (chunk) => {
        output.push(chunk)
      },
      onRestore: (snapshot, onComplete) => {
        restored = snapshot
        restoreCompletion.complete = onComplete
      },
      onClose: () => {},
    })
    await flush()

    const io = transport.sockets.find((s) => s.path.includes('/io'))
    const control = transport.sockets.find((s) => s.path.includes('/control'))
    expect(io).toBeDefined()
    expect(control).toBeDefined()

    io?.deliver('live-before-restore')
    control?.deliver(JSON.stringify({ type: 'restore', snapshot: 'history' }))
    io?.deliver('live-during-restore')

    expect(restored).toBe('history')
    expect(output).toEqual([])
    expect(control?.sent.map(String)).not.toContain(JSON.stringify({ type: 'restore_complete' }))

    if (!restoreCompletion.complete) throw new Error('Expected restore completion callback')
    restoreCompletion.complete()

    expect(control?.sent.map(String)).toContain(JSON.stringify({ type: 'restore_complete' }))
    expect(output).toEqual(['live-before-restore', 'live-during-restore'])

    client.dispose()
  })

  test('malformed control frames surface an error without poisoning the stream', async () => {
    const transport = makeFakeTransport()
    setApiTransport(transport)

    let error: string | null = null
    let restored: string | null = null
    const client = createTerminalClient({
      runId: 'r-bad-control',
      onError: (message) => {
        error = message
      },
      onExit: () => {},
      onOutput: () => {},
      onRestore: (snapshot) => {
        restored = snapshot
      },
      onClose: () => {},
    })
    await flush()

    const control = transport.sockets.find((s) => s.path.includes('/control'))
    expect(control).toBeDefined()

    control?.deliver('not-json')
    expect(error).toBe('Invalid terminal control message')

    control?.deliver(JSON.stringify({ type: 'restore', snapshot: 'after-bad-frame' }))
    expect(restored).toBe('after-bad-frame')

    client.dispose()
  })

  test('a tunnel-driven io socket close fires onClose exactly once (not a silent zombie)', async () => {
    const transport = makeFakeTransport()
    setApiTransport(transport)

    let closeCount = 0
    const client = createTerminalClient({
      runId: 'r1',
      onError: () => {},
      onExit: () => {},
      onOutput: () => {},
      onRestore: () => {},
      onClose: () => {
        closeCount += 1
      },
    })
    await flush()

    const io = transport.sockets.find((s) => s.path.includes('/io'))
    const control = transport.sockets.find((s) => s.path.includes('/control'))
    expect(io).toBeDefined()
    expect(control).toBeDefined()

    // Deliver a restore + some output so the stream is live, then simulate the tunnel resetAll()
    // remote-closing the io socket (network switch / lock screen). The client must surface it.
    control?.deliver(JSON.stringify({ type: 'restore', snapshot: 'hello' }))
    io?.deliver('output-1')
    expect(closeCount).toBe(0)

    io?.remoteClose(1006, 'transient')
    expect(closeCount).toBe(1)

    // A subsequent control close on the SAME (already-disposed-by-the-caller) stream must NOT
    // double-fire: the caller drives exactly one remount per drop.
    control?.remoteClose(1006, 'transient')
    expect(closeCount).toBe(1)

    client.dispose()
  })

  test('dispose() does NOT fire onClose (a deliberate teardown is not a reconnect signal)', async () => {
    const transport = makeFakeTransport()
    setApiTransport(transport)

    let closeCount = 0
    const client = createTerminalClient({
      runId: 'r2',
      onError: () => {},
      onExit: () => {},
      onOutput: () => {},
      onRestore: () => {},
      onClose: () => {
        closeCount += 1
      },
    })
    await flush()

    // dispose() closes both sockets, but that is an intentional unmount, not a tunnel drop — onClose
    // must stay silent so the caller does not remount a deliberately-torn-down terminal.
    client.dispose()
    expect(closeCount).toBe(0)
  })
})
