// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { TerminalView } from '../../web/src/terminal/TerminalView.js'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 1

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  close() {}
  send() {}
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
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
  vi.unstubAllGlobals()
})

describe('TerminalView', () => {
  test('opens io and control sockets for the provided run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)

    render(<TerminalView runId="run-123" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances.map((socket) => socket.url)).toEqual([
        'ws://localhost:3000/ws/terminal/run-123/io',
        'ws://localhost:3000/ws/terminal/run-123/control',
      ])
    })
  })
})
