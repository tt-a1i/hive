// @vitest-environment jsdom
//
// VULN-RELIABILITY-2 (the remount half) — when the tunnel reconnects, useTerminalRun must REMOUNT the
// terminal client with a fresh clientId so the daemon re-runs attachControl and replays a fresh
// snapshot. Before the fix the hook keyed the client only on [runId, inputProfile], so a connection
// flap reused the dead MuxSocket and the pane froze. Here we drive the client's onClose (the tunnel-
// drop signal terminal-client now surfaces) and assert a NEW pair of sockets is opened with a NEW
// clientId, then a restore is delivered on the fresh control stream.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { setApiTransport } from '../../web/src/api.js'
import { useTerminalRun } from '../../web/src/terminal/useTerminalRun.js'
import type { ApiTransport, TransportSocket } from '../../web/src/transport/api-transport.js'

let canvasGetContextSpy: { mockRestore: () => void } | undefined
beforeEach(() => {
  canvasGetContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => ({}) as never)
})

// Minimal xterm doubles so useTerminalRun can mount in jsdom. We only care about the client lifecycle.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = {
      active: { baseY: 0, viewportY: 0 },
      onBufferChange() {
        return { dispose() {} }
      },
    }
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    modes = { applicationCursorKeysMode: false }
    attachCustomKeyEventHandler() {}
    loadAddon() {}
    onBinary() {
      return { dispose() {} }
    }
    onData() {
      return { dispose() {} }
    }
    onScroll() {
      return { dispose() {} }
    }
    hasSelection() {
      return false
    }
    open() {}
    scrollToBottom() {}
    write(_chunk?: string, cb?: () => void) {
      cb?.()
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

interface OpenedSocket extends TransportSocket {
  readonly path: string
  readonly clientId: string | undefined
  remoteClose(code: number): void
  deliver(data: string): void
}

const opened: OpenedSocket[] = []
type SocketOpenBehavior = 'close' | 'open'

class FakeSocket implements OpenedSocket {
  readonly OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBufferLike | Uint8Array }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly path: string
  readonly clientId: string | undefined

  constructor(
    path: string,
    params?: Record<string, number | string | undefined>,
    openBehavior: SocketOpenBehavior = 'open'
  ) {
    this.path = path
    this.clientId = params?.clientId === undefined ? undefined : String(params.clientId)
    queueMicrotask(() => {
      if (openBehavior === 'close') {
        this.remoteClose(1006)
        return
      }
      this.onopen?.()
    })
  }
  send() {}
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  remoteClose(code: number) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code })
  }
  deliver(data: string) {
    this.onmessage?.({ data })
  }
}

const fakeTransport = (
  fetchImpl?: ApiTransport['fetch'],
  options: { closeFirstIo?: boolean } = {}
): ApiTransport => {
  let firstIoClosed = false
  return {
    fetch: fetchImpl ?? (() => Promise.reject(new Error('not used'))),
    openWebSocket: (path, params) => {
      const closeThisIo = options.closeFirstIo && !firstIoClosed && path.includes('/io')
      if (closeThisIo) firstIoClosed = true
      const s = new FakeSocket(path, params, closeThisIo ? 'close' : 'open')
      opened.push(s)
      return s
    },
  }
}

const Harness = ({ onExit, runId }: { onExit?: () => void; runId: string }) => {
  const { containerRef, error, status } = useTerminalRun(runId, 'default', onExit)
  return (
    <>
      <div data-testid="terminal-status">{status}</div>
      {error ? <div role="alert">{error}</div> : null}
      <div ref={containerRef} style={{ width: 400, height: 300 }} />
    </>
  )
}

afterEach(() => {
  cleanup()
  opened.length = 0
  canvasGetContextSpy?.mockRestore()
  canvasGetContextSpy = undefined
  setApiTransport({
    fetch: () => Promise.reject(new Error('reset')),
    openWebSocket: () => {
      throw new Error('reset')
    },
  })
})

describe('useTerminalRun — remount on tunnel reconnect (VULN-RELIABILITY-2)', () => {
  test('stops instead of reconnecting forever when the runtime says the run is gone', async () => {
    const fetchRun = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Run not found' }), {
          headers: { 'content-type': 'application/json' },
          status: 404,
        })
    )
    const onExit = vi.fn()
    setApiTransport(fakeTransport(fetchRun, { closeFirstIo: true }))
    render(<Harness onExit={onExit} runId="run-gone-before-attach" />)

    await waitFor(() => {
      expect(screen.getByTestId('terminal-status')).toHaveTextContent('stopped')
    })
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(opened).toHaveLength(2)
  })

  test('keeps reconnecting when the close probe reaches a runtime error instead of 404', async () => {
    const fetchRun = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'sync exploded' }), {
          headers: { 'content-type': 'application/json' },
          status: 500,
        })
    )
    const onExit = vi.fn()
    setApiTransport(fakeTransport(fetchRun, { closeFirstIo: true }))
    render(<Harness onExit={onExit} runId="run-probe-500" />)

    await waitFor(() => expect(opened.length).toBeGreaterThan(2))
    expect(fetchRun).toHaveBeenCalledWith('/api/runtime/runs/run-probe-500', {
      mode: 'same-origin',
    })
    expect(screen.getByTestId('terminal-status')).toHaveTextContent('connecting')
    expect(onExit).not.toHaveBeenCalled()
  })

  test('surfaces authorization probe failures instead of reconnecting forever', async () => {
    const fetchRun = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'UI endpoint requires valid UI token' }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        })
    )
    const onExit = vi.fn()
    setApiTransport(fakeTransport(fetchRun, { closeFirstIo: true }))
    render(<Harness onExit={onExit} runId="run-probe-auth" />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('UI endpoint requires valid UI token')
    })
    expect(fetchRun).toHaveBeenCalledWith('/api/runtime/runs/run-probe-auth', {
      mode: 'same-origin',
    })
    expect(onExit).not.toHaveBeenCalled()
    expect(opened).toHaveLength(2)
  })

  test('keeps the pane connecting until the daemon sends the restore snapshot', async () => {
    setApiTransport(fakeTransport())
    render(<Harness runId="run-connects-after-restore" />)

    await waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(2))
    expect(screen.getByTestId('terminal-status')).toHaveTextContent('connecting')

    const control = opened.find((s) => s.path.includes('/control'))
    expect(control).toBeDefined()
    control?.deliver(JSON.stringify({ type: 'restore', snapshot: 'ready' }))

    await waitFor(() => expect(screen.getByTestId('terminal-status')).toHaveTextContent('running'))
  })

  test('a tunnel-drop close remounts with a fresh clientId and replays a fresh snapshot', async () => {
    setApiTransport(fakeTransport())
    render(<Harness runId="run-x" />)

    // First mount: io + control sockets open with one clientId.
    await waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(2))
    const firstControl = opened.find((s) => s.path.includes('/control'))
    const firstIo = opened.find((s) => s.path.includes('/io'))
    expect(firstControl).toBeDefined()
    expect(firstIo).toBeDefined()
    const firstClientId = firstControl?.clientId
    expect(firstClientId).toBeTruthy()

    // The daemon mirror replays a restore on the control stream (snapshot on attachControl).
    firstControl?.deliver(JSON.stringify({ type: 'restore', snapshot: 'before-drop' }))
    firstIo?.deliver('live-output')

    const beforeCount = opened.length

    // Tunnel drop: frame-mux resetAll -> _remoteClose on the io socket. The hook must remount.
    firstIo?.remoteClose(1006)

    // A NEW pair of sockets opens for the remount, with a DIFFERENT clientId.
    await waitFor(() => expect(opened.length).toBeGreaterThan(beforeCount))
    const newControl = opened.slice(beforeCount).find((s) => s.path.includes('/control'))
    if (!newControl) throw new Error('no control socket opened on remount')
    expect(newControl.clientId).toBeTruthy()
    expect(newControl.clientId).not.toBe(firstClientId)

    // The fresh control stream gets a fresh snapshot — the daemon re-runs attachControl on remount.
    let restoredAgain = false
    newControl.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string }
      if (msg.type === 'restore') restoredAgain = true
    }
    newControl.deliver(JSON.stringify({ type: 'restore', snapshot: 'after-reconnect' }))
    expect(restoredAgain).toBe(true)
  })

  test('does not surface Connecting again while a restored run remounts', async () => {
    setApiTransport(fakeTransport())
    render(<Harness runId="run-visual-reconnect" />)

    await waitFor(() => expect(opened.length).toBeGreaterThanOrEqual(2))
    const firstControl = opened.find((s) => s.path.includes('/control'))
    const firstIo = opened.find((s) => s.path.includes('/io'))
    expect(firstControl).toBeDefined()
    expect(firstIo).toBeDefined()

    firstControl?.deliver(JSON.stringify({ type: 'restore', snapshot: 'before-drop' }))
    await waitFor(() => expect(screen.getByTestId('terminal-status')).toHaveTextContent('running'))

    const beforeCount = opened.length
    firstIo?.remoteClose(1006)

    await waitFor(() => expect(opened.length).toBeGreaterThan(beforeCount))
    expect(screen.getByTestId('terminal-status')).toHaveTextContent('running')
  })
})
