// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { TerminalView } from '../../web/src/terminal/TerminalView.js'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  sent: string[] = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.onopen?.()
    })
  }

  close() {}
  send(payload: string) {
    this.sent.push(payload)
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  constructor(readonly callback: () => void) {
    MockResizeObserver.instances.push(this)
  }

  disconnect() {}
  observe() {}
  trigger() {
    this.callback()
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 132
    rows = 43
    loadAddon() {}
    onData() {
      return { dispose() {} }
    }
    open() {}
    write(_chunk?: string, callback?: () => void) {
      callback?.()
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

afterEach(() => {
  cleanup()
  MockWebSocket.instances = []
  MockResizeObserver.instances = []
  vi.unstubAllGlobals()
})

const addPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `orch-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

describe('TerminalView', () => {
  test('opens io and control sockets for the provided run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-123')

    render(<TerminalView runId="run-123" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances.map((socket) => socket.url)).toEqual([
        'ws://localhost:3000/ws/terminal/run-123/io?cols=132&rows=43',
        'ws://localhost:3000/ws/terminal/run-123/control?cols=132&rows=43',
      ])
    })
  })

  test('sends the initial fit resize after the control socket opens', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-resize')

    render(<TerminalView runId="run-resize" title="Alice" />)

    await waitFor(() => {
      const controlSocket = MockWebSocket.instances[1]
      expect(controlSocket?.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'resize',
        cols: 132,
        rows: 43,
      })
    })
  })

  test('resizes again when the terminal container changes size', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-observer')

    render(<TerminalView runId="run-observer" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
    })

    MockResizeObserver.instances[0]?.trigger()

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent).toHaveLength(2)
    })
  })

  test('does not render an inline terminal before a portal slot exists', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)

    render(<TerminalView runId="run-detached" title="Alice" />)

    expect(document.querySelector('[data-testid="terminal-run-detached"]')).toBeNull()
    expect(document.querySelector('section[aria-label="Terminal Alice"]')).toBeNull()
    expect(MockWebSocket.instances).toHaveLength(0)

    const slot = addPortalSlot('run-detached')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-detached"]')).not.toBeNull()
    })
    expect(MockWebSocket.instances.map((socket) => socket.url)).toEqual([
      'ws://localhost:3000/ws/terminal/run-detached/io?cols=132&rows=43',
      'ws://localhost:3000/ws/terminal/run-detached/control?cols=132&rows=43',
    ])
  })
})
