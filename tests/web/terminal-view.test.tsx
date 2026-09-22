// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { TerminalView } from '../../web/src/terminal/TerminalView.js'

// useTerminalRun now probes WebGL support before loading @xterm/addon-webgl, but
// jsdom's canvas has no real GL context (getContext returns null), which would
// make detection report "no WebGL" and skip the addon. These suites assert the
// addon DOES load on a capable host, so stub a truthy context for the duration.
let canvasGetContextSpy: { mockRestore: () => void } | undefined
beforeEach(() => {
  canvasGetContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => ({}) as never)
})

let latestCustomKeyHandler: ((event: KeyboardEvent) => boolean) | undefined
let latestCustomWheelHandler: ((event: WheelEvent) => boolean) | undefined
let latestOnBinaryHandler: ((chunk: string) => void) | undefined
let latestOnDataHandler: ((chunk: string) => void) | undefined
let terminalMouseReport = '\x1b[M !!'
let terminalWrites: string[] = []
let terminalLoadEvents: string[] = []
let terminalBufferType: 'alternate' | 'normal' = 'normal'
let terminalMouseTrackingMode: 'any' | 'drag' | 'none' | 'vt200' | 'x10' = 'none'
let terminalApplicationCursorKeysMode = false
let terminalSelection = ''
let terminalDisposeCount = 0
let terminalFitCount = 0
let terminalFocusCount = 0
let terminalOpenCount = 0
let terminalScrollLines: number[] = []
let websocketCloseCount = 0
const ESC = '\x1b'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static autoRestore = true

  readonly OPEN = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  readyState = 0
  sent: Array<string | Uint8Array> = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    terminalLoadEvents.push('websocket')
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.onopen?.()
      if (MockWebSocket.autoRestore && this.url.includes('/control?')) {
        this.onmessage?.({ data: JSON.stringify({ type: 'restore', snapshot: '' }) })
      }
    })
  }

  close() {
    this.readyState = 3
    websocketCloseCount += 1
    this.onclose?.({ code: 1000 })
  }

  send(payload: string | Uint8Array) {
    if (this.readyState !== this.OPEN) return
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
    private customWheelHandler: ((event: WheelEvent) => boolean) | undefined
    private element: HTMLElement | null = null
    unicode = { activeVersion: '' }
    get buffer() {
      return {
        active: { baseY: 0, type: terminalBufferType, viewportY: 0 },
        onBufferChange() {
          return { dispose() {} }
        },
      }
    }
    get modes() {
      return {
        applicationCursorKeysMode: terminalApplicationCursorKeysMode,
        mouseTrackingMode: terminalMouseTrackingMode,
      }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      latestCustomKeyHandler = handler
    }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
      latestCustomWheelHandler = handler
      this.customWheelHandler = handler
    }
    loadAddon(addon: { addonName?: string }) {
      terminalLoadEvents.push(addon.addonName ?? 'unknown')
    }
    onBinary(handler: (chunk: string) => void) {
      latestOnBinaryHandler = handler
      return { dispose() {} }
    }
    onData(handler: (chunk: string) => void) {
      latestOnDataHandler = handler
      return { dispose() {} }
    }
    onScroll() {
      return { dispose() {} }
    }
    hasSelection() {
      return terminalSelection.length > 0
    }
    getSelection() {
      return terminalSelection
    }
    clearSelection() {
      terminalSelection = ''
    }
    open(element: HTMLElement) {
      terminalLoadEvents.push('open')
      terminalOpenCount += 1
      this.element = element
      const textarea = document.createElement('textarea')
      textarea.className = 'xterm-helper-textarea'
      textarea.addEventListener(
        'keydown',
        (event) => {
          if (event.key.length === 1) latestOnDataHandler?.(event.key)
          else if (event.key === 'Backspace') latestOnDataHandler?.('\u007f')
        },
        { capture: true }
      )
      textarea.addEventListener(
        'input',
        (event) => {
          const input = event as InputEvent
          if (input.inputType === 'insertText' && input.data) {
            latestOnDataHandler?.(input.data)
            input.preventDefault()
          }
        },
        { capture: true }
      )
      element.appendChild(textarea)
      element.addEventListener('wheel', (event) => {
        if (this.customWheelHandler?.(event) === false) {
          event.preventDefault()
          event.stopPropagation()
        }
      })
      element.addEventListener('mousedown', () => {
        latestOnBinaryHandler?.(terminalMouseReport)
      })
    }
    focus() {
      terminalFocusCount += 1
      this.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
    }
    write(chunk?: string, callback?: () => void) {
      // Record rendered bytes, not empty native-write barriers.
      if (chunk) terminalWrites.push(chunk)
      callback?.()
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    input(data: string) {
      latestOnDataHandler?.(data)
    }
    scrollLines(amount: number) {
      terminalScrollLines.push(amount)
    }
    scrollToBottom() {}
    dispose() {
      terminalDisposeCount += 1
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    addonName = 'fit'
    fit() {
      terminalFitCount += 1
    }
    proposeDimensions() {
      return { cols: 132, rows: 43 }
    }
    dispose() {}
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    addonName = 'unicode11'
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    addonName = 'webgl'
    onContextLoss() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    addonName = 'clipboard'
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    addonName = 'webLinks'
  },
}))

afterEach(() => {
  cleanup()
  MockWebSocket.instances = []
  MockWebSocket.autoRestore = true
  MockResizeObserver.instances = []
  latestCustomKeyHandler = undefined
  latestCustomWheelHandler = undefined
  latestOnBinaryHandler = undefined
  latestOnDataHandler = undefined
  terminalMouseReport = '\x1b[M !!'
  terminalWrites = []
  terminalLoadEvents = []
  terminalApplicationCursorKeysMode = false
  terminalBufferType = 'normal'
  terminalSelection = ''
  terminalDisposeCount = 0
  terminalFitCount = 0
  terminalFocusCount = 0
  terminalMouseTrackingMode = 'none'
  terminalOpenCount = 0
  terminalScrollLines = []
  websocketCloseCount = 0
  canvasGetContextSpy?.mockRestore()
  canvasGetContextSpy = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const addPortalSlot = (runId: string, options: { autoFocus?: boolean } = {}) => {
  const slot = document.createElement('div')
  slot.id = `orch-pty-${runId}`
  slot.dataset.ptySlot = 'orchestrator'
  if (options.autoFocus) slot.dataset.terminalAutoFocus = 'true'
  document.body.appendChild(slot)
  return slot
}

const setPortalSlotSize = (slot: HTMLElement, width: number, height: number) => {
  slot.dataset.testTerminalWidth = String(width)
  slot.dataset.testTerminalHeight = String(height)
}

const installPortalSlotSizeReads = () => {
  const widthSpy = vi
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockImplementation(function getClientWidth(this: HTMLElement) {
      const slot = this.closest<HTMLElement>('[data-test-terminal-width]')
      return slot ? Number(slot.dataset.testTerminalWidth) : 0
    })
  const heightSpy = vi
    .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockImplementation(function getClientHeight(this: HTMLElement) {
      const slot = this.closest<HTMLElement>('[data-test-terminal-height]')
      return slot ? Number(slot.dataset.testTerminalHeight) : 0
    })
  return () => {
    widthSpy.mockRestore()
    heightSpy.mockRestore()
  }
}

const parseControlMessages = (socket: MockWebSocket | undefined) =>
  socket?.sent.map((payload) => JSON.parse(String(payload))) ?? []

const addWorkerPortalSlot = (runId: string, options: { autoFocus?: boolean } = {}) => {
  const slot = document.createElement('div')
  slot.id = `worker-pty-${runId}`
  slot.dataset.ptySlot = 'worker'
  if (options.autoFocus) slot.dataset.terminalAutoFocus = 'true'
  document.body.appendChild(slot)
  return slot
}

const addShellPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `shell-pty-${runId}`
  slot.dataset.ptySlot = 'shell'
  document.body.appendChild(slot)
  return slot
}

const binaryInput = (chunk: string) =>
  Uint8Array.from(chunk, (character) => character.charCodeAt(0) & 0xff)

describe('TerminalView', () => {
  test('opens io and control sockets for the provided run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-123')

    render(<TerminalView runId="run-123" title="Alice" />)

    await waitFor(() => {
      const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
      expect(urls.map((url) => url.pathname)).toEqual([
        '/ws/terminal/run-123/io',
        '/ws/terminal/run-123/control',
      ])
      expect(urls[0]?.searchParams.get('clientId')).toBeTruthy()
      expect(urls[1]?.searchParams.get('clientId')).toBe(urls[0]?.searchParams.get('clientId'))
      expect(urls[0]?.searchParams.get('cols')).toBe('132')
      expect(urls[0]?.searchParams.get('rows')).toBe('43')
    })
  })

  test('auto-focuses an opt-in orchestrator terminal on mount and window focus', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-auto-focus', { autoFocus: true })

    render(<TerminalView runId="run-auto-focus" title="Alice" />)

    await waitFor(() => expect(terminalFocusCount).toBe(1))
    expect(document.activeElement).toHaveClass('xterm-helper-textarea')

    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(terminalFocusCount).toBe(2))
    expect(document.activeElement).toHaveClass('xterm-helper-textarea')
    button.remove()
  })

  test('auto-focuses an opt-in worker terminal when its slot appears', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)

    render(<TerminalView runId="run-worker-auto-focus" title="Alice" />)
    expect(MockWebSocket.instances).toHaveLength(0)

    const slot = addWorkerPortalSlot('run-worker-auto-focus', { autoFocus: true })

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-worker-auto-focus"]')).not.toBeNull()
      expect(terminalFocusCount).toBe(1)
    })
    expect(document.activeElement).toHaveClass('xterm-helper-textarea')
  })

  test('does not auto-focus shell terminal slots', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addShellPortalSlot('run-shell-no-focus')

    render(<TerminalView runId="run-shell-no-focus" title="Shell" />)

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2))
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    expect(terminalFocusCount).toBe(0)
  })

  test('does not steal focus from an active text field on window focus', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-keep-input-focus', { autoFocus: true })

    render(<TerminalView runId="run-keep-input-focus" title="Alice" />)

    await waitFor(() => expect(terminalFocusCount).toBe(1))

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await new Promise((resolve) => window.setTimeout(resolve, 10))
    expect(terminalFocusCount).toBe(1)
    expect(document.activeElement).toBe(input)
    input.remove()
  })

  test('surfaces terminal exit with the run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-exit')
    const onRunExited = vi.fn()

    render(<TerminalView onRunExited={onRunExited} runId="run-exit" title="Alice" />)

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2))
    act(() => {
      MockWebSocket.instances[1]?.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) })
    })

    expect(onRunExited).toHaveBeenCalledWith('run-exit')
  })

  test('sends the initial fit resize after the control socket opens', async () => {
    const restoreSizeReads = installPortalSlotSizeReads()
    try {
      vi.stubGlobal('WebSocket', MockWebSocket as never)
      const slot = addPortalSlot('run-resize')
      setPortalSlotSize(slot, 800, 500)

      render(<TerminalView runId="run-resize" title="Alice" />)

      await waitFor(() => {
        expect(parseControlMessages(MockWebSocket.instances[1])).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 800,
          pixelHeight: 500,
        })
      })
    } finally {
      restoreSizeReads()
    }
  })

  test('loads critical addons before connecting sockets and visual addons after open', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-staged-addons')

    render(<TerminalView runId="run-staged-addons" title="Alice" />)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('open')
    })
    const openIndex = terminalLoadEvents.indexOf('open')
    expect(terminalLoadEvents.indexOf('fit')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('fit')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(openIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('websocket')
    })
    const websocketIndex = terminalLoadEvents.indexOf('websocket')
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(websocketIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toEqual(expect.arrayContaining(['webLinks', 'webgl']))
    })
    expect(terminalLoadEvents.indexOf('webLinks')).toBeGreaterThan(openIndex)
    expect(terminalLoadEvents.indexOf('webgl')).toBeGreaterThan(openIndex)
    await waitFor(() => {
      expect(terminalFitCount).toBeGreaterThanOrEqual(1)
    })
  })

  test('resizes again when the terminal container changes size', async () => {
    const restoreSizeReads = installPortalSlotSizeReads()
    try {
      vi.stubGlobal('WebSocket', MockWebSocket as never)
      vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
      const slot = addPortalSlot('run-observer')
      setPortalSlotSize(slot, 800, 500)

      render(<TerminalView runId="run-observer" title="Alice" />)

      await waitFor(() => {
        expect(parseControlMessages(MockWebSocket.instances[1])).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 800,
          pixelHeight: 500,
        })
      })

      setPortalSlotSize(slot, 960, 640)
      MockResizeObserver.instances[0]?.trigger()

      await waitFor(() => {
        expect(parseControlMessages(MockWebSocket.instances[1])).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 960,
          pixelHeight: 640,
        })
      })
    } finally {
      restoreSizeReads()
    }
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
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    expect(MockWebSocket.instances.map((socket) => new URL(socket.url).pathname)).toEqual([
      '/ws/terminal/run-detached/io',
      '/ws/terminal/run-detached/control',
    ])
  })

  test('observes portal slots without a polling interval when MutationObserver is available', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    render(<TerminalView runId="run-observed-slot" title="Alice" />)

    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    const slot = addPortalSlot('run-observed-slot')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-observed-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('does not rescan portal slots for terminal-internal mutations', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-internal-mutation')

    render(<TerminalView runId="run-internal-mutation" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-internal-mutation"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const terminalNode = slot.querySelector<HTMLElement>(
      '[data-testid="terminal-run-internal-mutation"]'
    )
    expect(terminalNode).not.toBeNull()
    const internalNode = document.createElement('div')
    terminalNode?.appendChild(internalNode)
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    const querySelectorAllSpy = vi.spyOn(document, 'querySelectorAll')
    const elementQuerySelectorSpy = vi.spyOn(Element.prototype, 'querySelector')
    try {
      for (let index = 0; index < 20; index += 1) {
        internalNode.setAttribute('style', `transform: translateX(${index}px)`)
      }
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      expect(querySelectorAllSpy).not.toHaveBeenCalled()
      expect(elementQuerySelectorSpy).not.toHaveBeenCalled()

      for (let index = 0; index < 20; index += 1) {
        const child = document.createElement('span')
        child.textContent = String(index)
        internalNode.appendChild(child)
        child.remove()
      }
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      expect(querySelectorAllSpy).not.toHaveBeenCalled()
      expect(elementQuerySelectorSpy).not.toHaveBeenCalled()
    } finally {
      querySelectorAllSpy.mockRestore()
      elementQuerySelectorSpy.mockRestore()
    }
  })

  test('detaches when an existing portal slot loses data-pty-slot', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-slot-disabled')

    render(<TerminalView runId="run-slot-disabled" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-slot-disabled"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    delete slot.dataset.ptySlot

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-slot-disabled"]')).toBeNull()
    })
  })

  test('uses the last matching portal slot when duplicate slots exist', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const firstSlot = addWorkerPortalSlot('run-duplicate-slot')
    const secondSlot = addWorkerPortalSlot('run-duplicate-slot')

    render(<TerminalView runId="run-duplicate-slot" title="Alice" />)

    await waitFor(() => {
      expect(firstSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).toBeNull()
      expect(secondSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('does not attach to a portal slot inside a hidden mobile pane', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const pane = document.createElement('div')
    pane.className = 'hidden'
    const slot = document.createElement('div')
    slot.id = 'worker-pty-run-hidden-slot'
    slot.dataset.ptySlot = 'worker'
    pane.appendChild(slot)
    document.body.appendChild(pane)

    render(<TerminalView runId="run-hidden-slot" title="Alice" />)

    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(slot.querySelector('[data-testid="terminal-run-hidden-slot"]')).toBeNull()
    expect(MockWebSocket.instances).toHaveLength(0)

    pane.className = 'flex'

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-hidden-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('ignores unrelated matching ids when resolving portal slots', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const unrelatedMatch = document.createElement('div')
    unrelatedMatch.id = 'worker-pty-run-narrow-slot'
    document.body.appendChild(unrelatedMatch)
    for (let index = 0; index < 200; index++) {
      const node = document.createElement('div')
      node.id = index % 2 === 0 ? 'worker-pty-run-narrow-slot' : `unrelated-${index}`
      document.body.appendChild(node)
    }
    const slot = addWorkerPortalSlot('run-narrow-slot')

    render(<TerminalView runId="run-narrow-slot" title="Alice" />)

    await waitFor(() => {
      expect(unrelatedMatch.querySelector('[data-testid="terminal-run-narrow-slot"]')).toBeNull()
      expect(slot.querySelector('[data-testid="terminal-run-narrow-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('attaches to shell terminal portal slots', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addShellPortalSlot('run-shell')

    render(<TerminalView runId="run-shell" title="Shell" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-shell"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(new URL(MockWebSocket.instances[0]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/io'
      )
      expect(new URL(MockWebSocket.instances[1]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/control'
      )
    })
  })

  test('keeps the same xterm session alive when the portal slot is recreated', async () => {
    const restoreSizeReads = installPortalSlotSizeReads()
    try {
      vi.stubGlobal('WebSocket', MockWebSocket as never)
      vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
      let slot = addPortalSlot('run-stable')
      setPortalSlotSize(slot, 800, 500)

      render(<TerminalView runId="run-stable" title="Alice" />)

      await waitFor(() => {
        expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
        expect(MockWebSocket.instances).toHaveLength(2)
        expect(MockResizeObserver.instances).toHaveLength(1)
      })
      const [ioSocket, controlSocket] = MockWebSocket.instances
      await waitFor(() => {
        expect(parseControlMessages(controlSocket)).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 800,
          pixelHeight: 500,
        })
      })
      const sentBeforeVisibleResize = controlSocket?.sent.length ?? 0
      setPortalSlotSize(slot, 920, 620)
      MockResizeObserver.instances[0]?.trigger()
      await waitFor(() => {
        expect(controlSocket?.sent.length).toBeGreaterThan(sentBeforeVisibleResize)
      })

      slot.remove()

      await waitFor(() => {
        expect(document.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
      })
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(websocketCloseCount).toBe(0)
      expect(terminalDisposeCount).toBe(0)
      const sentBeforeHiddenResize = controlSocket?.sent.length ?? 0
      window.dispatchEvent(new Event('resize'))
      MockResizeObserver.instances[0]?.trigger()
      await new Promise((resolve) => window.setTimeout(resolve, 75))
      expect(controlSocket?.sent).toHaveLength(sentBeforeHiddenResize)

      slot = addPortalSlot('run-stable')
      setPortalSlotSize(slot, 960, 640)

      await waitFor(() => {
        expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
      })
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(terminalOpenCount).toBe(1)
      expect(terminalDisposeCount).toBe(0)
      await waitFor(() => {
        expect(controlSocket?.sent.length).toBeGreaterThan(sentBeforeHiddenResize)
      })
      const sentBeforeProtocolMessages = controlSocket?.sent.length ?? 0

      const restoredHistory = '恢复历史：中文 😀'
      const liveAfterReattach = '切换后：English，中文。'
      controlSocket?.onmessage?.({
        data: JSON.stringify({ type: 'restore', snapshot: restoredHistory }),
      })
      ioSocket?.onmessage?.({ data: liveAfterReattach })
      expect(terminalWrites).toEqual([restoredHistory, liveAfterReattach])
      const controlMessagesAfterReattach = controlSocket?.sent
        .slice(sentBeforeProtocolMessages)
        .map((payload) => JSON.parse(String(payload)))
      expect(controlMessagesAfterReattach).toEqual([
        { type: 'restore_complete' },
        { type: 'output_ack', bytes: new TextEncoder().encode(liveAfterReattach).byteLength },
      ])

      latestOnDataHandler?.('typed-after-reattach')
      expect(ioSocket?.sent).toContain('typed-after-reattach')
      latestCustomKeyHandler?.(
        new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
      )
      expect(ioSocket?.sent).toContain('\u001b[13;2u')
    } finally {
      restoreSizeReads()
    }
  })

  test('refits after a recreated portal slot settles to its final size', async () => {
    const restoreSizeReads = installPortalSlotSizeReads()
    try {
      vi.stubGlobal('WebSocket', MockWebSocket as never)
      vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
      let animationFrameId = 0
      const animationFrameTimers = new Map<number, number>()
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = ++animationFrameId
        const timer = window.setTimeout(() => {
          animationFrameTimers.delete(id)
          callback(performance.now())
        }, 0)
        animationFrameTimers.set(id, timer)
        return id
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        const timer = animationFrameTimers.get(id)
        if (timer !== undefined) window.clearTimeout(timer)
        animationFrameTimers.delete(id)
      })

      let slot = addWorkerPortalSlot('run-settled-fit')
      setPortalSlotSize(slot, 800, 500)

      render(<TerminalView runId="run-settled-fit" title="Alice" />)

      await waitFor(() => {
        expect(slot.querySelector('[data-testid="terminal-run-settled-fit"]')).not.toBeNull()
        expect(MockWebSocket.instances).toHaveLength(2)
      })
      const controlSocket = MockWebSocket.instances[1]
      await waitFor(() => {
        expect(parseControlMessages(controlSocket)).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 800,
          pixelHeight: 500,
        })
      })

      slot.remove()
      await waitFor(() => {
        expect(document.querySelector('[data-terminal-host-parked="true"]')).not.toBeNull()
      })
      const sentBeforeReattach = controlSocket?.sent.length ?? 0

      slot = addWorkerPortalSlot('run-settled-fit')
      setPortalSlotSize(slot, 320, 360)
      window.setTimeout(() => setPortalSlotSize(slot, 960, 640), 75)

      await waitFor(
        () => {
          const resizeMessages = parseControlMessages(controlSocket).filter(
            (message) => message.type === 'resize'
          )
          expect(resizeMessages).toContainEqual({
            type: 'resize',
            cols: 132,
            rows: 43,
            pixelWidth: 960,
            pixelHeight: 640,
          })
        },
        { timeout: 1_000 }
      )
      expect(controlSocket?.sent.length ?? 0).toBeGreaterThan(sentBeforeReattach)
      expect(terminalFitCount).toBe(1)
    } finally {
      restoreSizeReads()
    }
  })

  test('cancels pending visible refits when a recreated portal slot is removed again', async () => {
    const restoreSizeReads = installPortalSlotSizeReads()
    try {
      vi.stubGlobal('WebSocket', MockWebSocket as never)
      vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
      let slot = addWorkerPortalSlot('run-cancelled-visible-fit')
      setPortalSlotSize(slot, 800, 500)

      render(<TerminalView runId="run-cancelled-visible-fit" title="Alice" />)

      await waitFor(() => {
        expect(
          slot.querySelector('[data-testid="terminal-run-cancelled-visible-fit"]')
        ).not.toBeNull()
        expect(MockWebSocket.instances).toHaveLength(2)
      })
      const controlSocket = MockWebSocket.instances[1]
      await waitFor(() => {
        expect(parseControlMessages(controlSocket)).toContainEqual({
          type: 'resize',
          cols: 132,
          rows: 43,
          pixelWidth: 800,
          pixelHeight: 500,
        })
      })

      slot.remove()
      await waitFor(() => {
        expect(document.querySelector('[data-terminal-host-parked="true"]')).not.toBeNull()
      })

      slot = addWorkerPortalSlot('run-cancelled-visible-fit')
      setPortalSlotSize(slot, 320, 360)
      await waitFor(() => {
        expect(
          slot.querySelector('[data-testid="terminal-run-cancelled-visible-fit"]')
        ).not.toBeNull()
      })
      const sentBeforeSecondDetach = controlSocket?.sent.length ?? 0
      slot.remove()
      window.setTimeout(() => setPortalSlotSize(slot, 960, 640), 75)

      await new Promise((resolve) => window.setTimeout(resolve, 375))
      expect(controlSocket?.sent).toHaveLength(sentBeforeSecondDetach)
      expect(parseControlMessages(controlSocket)).not.toContainEqual({
        type: 'resize',
        cols: 132,
        rows: 43,
        pixelWidth: 960,
        pixelHeight: 640,
      })
    } finally {
      restoreSizeReads()
    }
  })

  test('disposes the terminal session when TerminalView unmounts', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-unmount')

    const view = render(<TerminalView runId="run-unmount" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-unmount"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).not.toBeNull()
    })

    view.unmount()

    expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).toBeNull()
    expect(document.getElementById('hive-terminal-parking-lot')).toBeNull()
    expect(websocketCloseCount).toBe(2)
    expect(terminalDisposeCount).toBe(1)
  })

  test('disposes a parked terminal when no portal slot returns', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-abandoned')

    render(<TerminalView runId="run-abandoned" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-abandoned"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).not.toBeNull()
    })

    await waitFor(
      () => {
        expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).toBeNull()
        expect(document.getElementById('hive-terminal-parking-lot')).toBeNull()
        expect(websocketCloseCount).toBe(2)
        expect(terminalDisposeCount).toBe(1)
      },
      { timeout: 1500 }
    )
  })

  test('buffers live output until the restore snapshot is written', async () => {
    MockWebSocket.autoRestore = false
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-restore-order')

    render(<TerminalView runId="run-restore-order" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.onmessage?.({ data: 'live-after-attach' })

    expect(terminalWrites).toEqual([])

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })

    expect(terminalWrites).toEqual(['restored-history', 'live-after-attach'])
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'restore_complete',
    })
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-after-attach').byteLength,
    })
  })

  test('writes mixed Unicode unchanged through restore and live output paths', async () => {
    MockWebSocket.autoRestore = false
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-unicode-output')
    render(<TerminalView runId="run-unicode-output" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    const snapshot = '历史：中文 😀\r\n'
    const live = '实时：English，中文。🎉'

    ioSocket?.onmessage?.({ data: live })
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot }),
    })

    expect(terminalWrites).toEqual([snapshot, live])
    expect(parseControlMessages(controlSocket)).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode(live).byteLength,
    })
  })

  test('sends one IME commit then immediate slash, English, and backspace without delay', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-ime-input')
    render(<TerminalView runId="run-ime-input" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(latestOnDataHandler).toBeDefined()
    })
    const [ioSocket] = MockWebSocket.instances
    const textarea = slot.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    expect(textarea).not.toBeNull()

    fireEvent.compositionStart(textarea as HTMLTextAreaElement)
    fireEvent.compositionUpdate(textarea as HTMLTextAreaElement, { data: '你' })
    fireEvent.compositionEnd(textarea as HTMLTextAreaElement, { data: '你好' })
    fireEvent.input(textarea as HTMLTextAreaElement, {
      data: '你好',
      inputType: 'insertFromComposition',
    })
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: '/' })
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: 'a' })
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: 'Backspace' })

    expect(ioSocket?.sent.map(String)).toEqual(['你好', '/', 'a', '\u007f'])

    fireEvent.compositionStart(textarea as HTMLTextAreaElement)
    fireEvent.compositionEnd(textarea as HTMLTextAreaElement, { data: '中文' })
    fireEvent.input(textarea as HTMLTextAreaElement, {
      data: '中文',
      inputType: 'insertFromComposition',
    })
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: 'b' })
    expect(ioSocket?.sent.map(String)).toEqual(['你好', '/', 'a', '\u007f', '中文', 'b'])
  })

  test('coalesces high-frequency live output while acknowledging rendered bytes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-output-batch')

    render(<TerminalView runId="run-output-batch" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: '' }),
    })

    const chunks = Array.from({ length: 100 }, (_, index) => `frame-${index}\n`)
    for (const chunk of chunks) ioSocket?.onmessage?.({ data: chunk })

    const encoder = new TextEncoder()
    const firstChunk = chunks[0] ?? ''
    const firstBytes = encoder.encode(firstChunk).byteLength
    const restBytes = encoder.encode(chunks.slice(1).join('')).byteLength
    expect(terminalWrites).toEqual([firstChunk])
    const outputAcksBeforeBatch = parseControlMessages(controlSocket).filter(
      (message) => message.type === 'output_ack'
    )
    expect(outputAcksBeforeBatch).toEqual([{ type: 'output_ack', bytes: firstBytes }])

    await waitFor(() => {
      expect(terminalWrites).toEqual([firstChunk, chunks.slice(1).join('')])
    })
    const outputAcksAfterBatch = parseControlMessages(controlSocket).filter(
      (message) => message.type === 'output_ack'
    )
    expect(outputAcksAfterBatch.reduce((bytes, message) => bytes + Number(message.bytes), 0)).toBe(
      firstBytes + restBytes
    )
  })

  test('pauses terminal repaint while parked and flushes output after reattach', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    let slot = addPortalSlot('run-parked-output')

    render(<TerminalView runId="run-parked-output" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-parked-output"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: '' }),
    })

    slot.remove()
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-parked="true"]')).not.toBeNull()
    })

    ioSocket?.onmessage?.({ data: 'parked-output' })
    expect(terminalWrites).toEqual([])
    const outputAcksWhileParked = parseControlMessages(controlSocket).filter(
      (message) => message.type === 'output_ack'
    )
    expect(outputAcksWhileParked).toEqual([
      { type: 'output_ack', bytes: new TextEncoder().encode('parked-output').byteLength },
    ])

    slot = addPortalSlot('run-parked-output')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-parked-output"]')).not.toBeNull()
      expect(terminalWrites).toEqual(['parked-output'])
    })
    const outputAcksAfterReattach = parseControlMessages(controlSocket).filter(
      (message) => message.type === 'output_ack'
    )
    expect(outputAcksAfterReattach).toEqual([
      { type: 'output_ack', bytes: new TextEncoder().encode('parked-output').byteLength },
    ])
  })

  test('preserves Codex cursor and erase sequences while acknowledging original bytes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-codex-repaint')

    render(<TerminalView inputProfile="codex" runId="run-codex-repaint" title="Codex" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    const repaint = [
      `${ESC}[61;3H${ESC}[?25h${ESC}[?2026h${ESC}[0 q${ESC}[?25l`,
      `${ESC}[59;2H${ESC}[K\r\n${ESC}[K${ESC}[61;34H${ESC}[K`,
      `${ESC}[?25h${ESC}[?2026l${ESC}[?25l`,
    ].join('')

    ioSocket?.onmessage?.({ data: repaint })

    expect(terminalWrites).toEqual(['restored-history', repaint])
    expect(parseControlMessages(controlSocket)).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode(repaint).byteLength,
    })
  })

  test('preserves Codex prompt edit repaint output after Backspace input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-codex-edit-repaint')

    render(<TerminalView inputProfile="codex" runId="run-codex-edit-repaint" title="Codex" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(latestOnDataHandler).toBeDefined()
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    terminalWrites = []
    latestOnDataHandler?.('\x7f')

    const repaint = [
      `${ESC}[61;3H${ESC}[?25h${ESC}[?2026h${ESC}[0 q${ESC}[?25l`,
      `${ESC}[59;2H${ESC}[K\r\n${ESC}[K${ESC}[61;34H${ESC}[K`,
      `${ESC}[?25h${ESC}[?2026l${ESC}[?25l`,
    ].join('')

    ioSocket?.onmessage?.({ data: repaint })

    expect(terminalWrites).toEqual([repaint])
    expect(parseControlMessages(controlSocket)).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode(repaint).byteLength,
    })
  })

  test('maps Shift+Enter to a modified Enter sequence instead of submit Enter', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-shift-enter')

    render(<TerminalView runId="run-shift-enter" title="Alice" />)

    await waitFor(() => {
      expect(latestCustomKeyHandler).toBeDefined()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
    })

    const keydownHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
    )
    const keypressHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
    )

    expect(keydownHandled).toBe(false)
    expect(keypressHandled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[13;2u'])
  })

  test('Ctrl+C with a selection copies to the clipboard instead of sending \\x03', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    addPortalSlot('run-ctrl-c-copy')

    try {
      render(<TerminalView runId="run-ctrl-c-copy" title="Alice" />)

      await waitFor(() => {
        expect(latestCustomKeyHandler).toBeDefined()
        expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      })

      terminalSelection = 'selected output'
      const handled = latestCustomKeyHandler?.(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })
      )

      expect(handled).toBe(false)
      expect(writeText).toHaveBeenCalledWith('selected output')
      expect(MockWebSocket.instances[0]?.sent).not.toContain('\x03')

      // Copy cleared the selection, so a second Ctrl+C now passes through to
      // interrupt instead of copying again.
      const second = latestCustomKeyHandler?.(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })
      )
      expect(second).toBe(true)
      expect(writeText).toHaveBeenCalledTimes(1)
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  test('Ctrl+C with no selection passes through so xterm still sends \\x03', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    addPortalSlot('run-ctrl-c-interrupt')

    try {
      render(<TerminalView runId="run-ctrl-c-interrupt" title="Alice" />)

      await waitFor(() => {
        expect(latestCustomKeyHandler).toBeDefined()
        expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      })

      terminalSelection = ''
      const handled = latestCustomKeyHandler?.(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })
      )

      expect(handled).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  test('falls back to arrow-key wheel input for alternate-screen TUIs without mouse tracking', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-alt')

    render(<TerminalView runId="run-wheel-alt" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-alt"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B', '\u001b[A'])
  })

  test('maps OpenCode wheel input to the message viewport scroll keys', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-opencode')

    render(<TerminalView inputProfile="opencode" runId="run-wheel-opencode" title="OpenCode" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-opencode"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', '\u001b[5~'])
  })

  test('keeps OpenCode wheel fallback active when mouse tracking is reported', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    addPortalSlot('run-wheel-opencode-mouse')

    render(
      <TerminalView inputProfile="opencode" runId="run-wheel-opencode-mouse" title="OpenCode" />
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-opencode-mouse"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', '\u001b[5~'])
  })

  test.each([
    { legacy: '\x1b[M !!', sgr: '\x1b[<0;1;1M' },
    { legacy: '\x1b[M#!!', sgr: '\x1b[<3;1;1m' },
    { legacy: '\x1b[M@!!', sgr: '\x1b[<32;1;1M' },
    { legacy: '\x1b[MC!!', sgr: '\x1b[<35;1;1M' },
    { legacy: '\x1b[M`!!', sgr: '\x1b[<64;1;1M' },
  ])('normalizes OpenCode legacy mouse input $sgr', async ({ legacy, sgr }) => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    terminalMouseReport = legacy
    addPortalSlot('run-opencode-mouse-click')

    render(
      <TerminalView inputProfile="opencode" runId="run-opencode-mouse-click" title="OpenCode" />
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-opencode-mouse-click"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await waitFor(() => {
      expect(latestCustomWheelHandler).toBeDefined()
      expect(latestOnBinaryHandler).toBeDefined()
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.mouseDown(terminal)

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', sgr])
  })

  test('passes default terminal binary mouse input through unchanged', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    addPortalSlot('run-default-mouse-click')

    render(<TerminalView runId="run-default-mouse-click" title="Shell" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-default-mouse-click"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await waitFor(() => {
      expect(latestOnBinaryHandler).toBeDefined()
    })

    fireEvent.mouseDown(terminal)

    expect(MockWebSocket.instances[0]?.sent).toEqual([binaryInput('\x1b[M !!')])
  })

  test('uses application cursor arrow sequences for alternate-screen wheel fallback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalApplicationCursorKeysMode = true
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-app-cursor')

    render(<TerminalView runId="run-wheel-app-cursor" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-app-cursor"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1 })
    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: -1 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001bOB', '\u001bOA'])
  })

  test('does not amplify small trackpad wheel deltas into one input per event', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-trackpad')

    render(<TerminalView runId="run-wheel-trackpad" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-trackpad"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    for (let index = 0; index < 5; index++) {
      fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })
    }
    expect(MockWebSocket.instances[0]?.sent).toEqual([])

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes alternate-screen fallback wheel events before page scroll handlers run', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-consume')

    render(<TerminalView runId="run-wheel-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes small alternate-screen trackpad wheel deltas even before emitting input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-small-consume')

    render(<TerminalView runId="run-wheel-small-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-small-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 10,
    })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('keeps normal scrollback wheel events out of PTY input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-wheel-normal')

    render(<TerminalView runId="run-wheel-normal" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-normal"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('mobile touch pans normal scrollback through xterm scrollLines', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-normal')

    render(
      <LayoutModeProvider value={{ mode: 'mobile' }}>
        <TerminalView runId="run-touch-normal" title="Alice" />
      </LayoutModeProvider>
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-normal"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.touchStart(terminal, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(terminal, { touches: [{ clientY: 168 }] })

    await waitFor(() => {
      expect(terminalScrollLines).toEqual([2])
    })
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('mobile touch pans alternate-screen TUIs through the existing input fallback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-touch-alt')

    render(
      <LayoutModeProvider value={{ mode: 'mobile' }}>
        <TerminalView runId="run-touch-alt" title="Alice" />
      </LayoutModeProvider>
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-alt"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.touchStart(terminal, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(terminal, { touches: [{ clientY: 80 }] })

    expect(terminalScrollLines).toEqual([])
    await waitFor(() => {
      expect(MockWebSocket.instances[0]?.sent).toEqual([
        '\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B',
      ])
    })
  })

  test.each([
    'any',
    'drag',
    'vt200',
    'x10',
  ] as const)('does not duplicate xterm %s mouse tracking wheel events', async (mouseTrackingMode) => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = mouseTrackingMode
    addPortalSlot('run-wheel-mouse')

    render(<TerminalView runId="run-wheel-mouse" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-mouse"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })
})
