import { getApiTransport } from '../api.js'
import type { TransportSocket } from '../transport/api-transport.js'

type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string; cols?: number; rows?: number; render_events?: boolean }

const INVALID_CONTROL_MESSAGE = 'Invalid terminal control message'

const parseControlMessage = (data: string | ArrayBufferLike | Uint8Array) => {
  let raw: unknown
  try {
    raw = JSON.parse(String(data))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const message = raw as {
    code?: unknown
    message?: unknown
    snapshot?: unknown
    type?: unknown
    cols?: number
    rows?: number
    render_events?: boolean
  }
  if (message.type === 'error' && typeof message.message === 'string') {
    return { type: 'error', message: message.message } satisfies TerminalControlServerMessage
  }
  if (message.type === 'exit' && (message.code === null || typeof message.code === 'number')) {
    return { type: 'exit', code: message.code } satisfies TerminalControlServerMessage
  }
  if (message.type === 'restore' && typeof message.snapshot === 'string') {
    return {
      type: 'restore',
      snapshot: message.snapshot,
      ...(message.cols === undefined ? {} : { cols: message.cols }),
      ...(message.rows === undefined ? {} : { rows: message.rows }),
      ...(message.render_events === undefined ? {} : { render_events: message.render_events }),
    } satisfies TerminalControlServerMessage
  }
  return null
}

interface TerminalClientOptions {
  initialSize?: {
    cols: number
    pixelHeight?: number
    pixelWidth?: number
    rows: number
  }
  onError: (message: string) => void
  onExit: (code: number | null) => void
  onOutput: (chunk: string, acknowledge: (bytes: number) => void) => void
  onRestore: (
    snapshot: string,
    onComplete: () => void,
    size?: { cols: number; rows: number }
  ) => void
  onResize?: (cols: number, rows: number) => void
  /**
   * Either underlying socket closed while this client was NOT deliberately disposed — i.e. a tunnel
   * reconnect (frame-mux resetAll -> _remoteClose) or a dropped same-origin ws. Fires AT MOST ONCE per
   * client so the caller can remount and take a FRESH snapshot (VULN-RELIABILITY-2). A dispose() never
   * fires it: a deliberate teardown is not a reconnect signal.
   */
  onClose?: () => void
  runId: string
}

export interface TerminalClient {
  dispose: () => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendBinaryInput: (chunk: string) => void
  sendInput: (chunk: string, userInput?: boolean) => void
}

const createClientId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // LAN HTTP origins lack randomUUID, but still provide cryptographic random
  // bytes. Keep UUID v4 format and entropy for both terminal socket channels.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const createTerminalClient = ({
  initialSize,
  onError,
  onExit,
  onOutput,
  onRestore,
  onResize,
  onClose,
  runId,
}: TerminalClientOptions): TerminalClient => {
  const clientId = createClientId()
  const connectionParams = { ...initialSize, clientId, render_events: 1 }
  const transport = getApiTransport()
  const ioSocket: TransportSocket = transport.openWebSocket(
    `/ws/terminal/${runId}/io`,
    connectionParams
  )
  const controlSocket: TransportSocket = transport.openWebSocket(
    `/ws/terminal/${runId}/control`,
    connectionParams
  )
  let restored = false
  let renderEvents = false
  let requestedSize = { cols: initialSize?.cols ?? 80, rows: initialSize?.rows ?? 24 }
  const pendingInput: Array<{ chunk: string; binary: boolean; userInput: boolean }> = []
  let disposed = false
  let closeSurfaced = false
  const pendingOutput: Array<{ chunk: string; acknowledge: (bytes: number) => void }> = []
  let pendingResize: {
    cols: number
    rows: number
    pixelWidth?: number
    pixelHeight?: number
  } | null = null

  // Either MuxSocket/ws closing while we did NOT dispose() means the tunnel dropped the stream (a
  // network switch / lock screen drives frame-mux.resetAll -> _remoteClose). Surface it once so the
  // caller can remount and pull a fresh snapshot (VULN-RELIABILITY-2): the same dead socket can never
  // re-run attachControl, so without a remount the pane freezes and output never resumes.
  const surfaceClose = (): void => {
    if (disposed || closeSurfaced) return
    closeSurfaced = true
    onClose?.()
  }
  ioSocket.onclose = surfaceClose
  controlSocket.onclose = surfaceClose

  const sendResize = () => {
    if (!pendingResize || controlSocket.readyState !== controlSocket.OPEN) return
    controlSocket.send(JSON.stringify({ type: 'resize', ...pendingResize }))
    if (restored && !renderEvents) onResize?.(pendingResize.cols, pendingResize.rows)
    pendingResize = null
  }

  const sendInput = (chunk: string, binary = false, userInput = true) => {
    if (disposed) return
    if (!restored || ioSocket.readyState !== ioSocket.OPEN) {
      pendingInput.push({ chunk, binary, userInput })
      return
    }
    if (renderEvents) {
      ioSocket.send(
        JSON.stringify({
          type: 'input',
          data: chunk,
          user_input: userInput,
          ...(binary ? { encoding: 'binary' } : {}),
          ...requestedSize,
        })
      )
    } else if (binary) {
      ioSocket.send(Uint8Array.from(chunk, (character) => character.charCodeAt(0) & 0xff))
    } else ioSocket.send(chunk)
  }

  const flushInput = () => {
    if (!restored || ioSocket.readyState !== ioSocket.OPEN) return
    for (const input of pendingInput.splice(0))
      sendInput(input.chunk, input.binary, input.userInput)
  }
  ioSocket.onopen = flushInput

  const deliverOutput = (chunk: string, acknowledge: (bytes: number) => void) => {
    if (!renderEvents) {
      onOutput(chunk, acknowledge)
      return
    }
    try {
      const event = JSON.parse(chunk)
      if (event.type === 'output' && typeof event.data === 'string')
        onOutput(event.data, acknowledge)
      else if (
        event.type === 'resize' &&
        Number.isInteger(event.cols) &&
        event.cols > 0 &&
        Number.isInteger(event.rows) &&
        event.rows > 0
      )
        onResize?.(event.cols, event.rows)
      else onError(INVALID_CONTROL_MESSAGE)
    } catch {
      onError(INVALID_CONTROL_MESSAGE)
    }
  }

  ioSocket.onmessage = (event) => {
    const chunk = typeof event.data === 'string' ? event.data : ''
    const acknowledge = (bytes: number) => {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'output_ack', bytes }))
    }
    if (!restored) {
      pendingOutput.push({ chunk, acknowledge })
      return
    }
    deliverOutput(chunk, acknowledge)
  }
  controlSocket.onopen = () => {
    sendResize()
  }
  controlSocket.onmessage = (event) => {
    const message = parseControlMessage(event.data)
    if (!message) {
      onError(INVALID_CONTROL_MESSAGE)
      return
    }
    if (message.type === 'exit') onExit(message.code)
    if (message.type === 'error') onError(message.message)
    if (message.type === 'restore') {
      renderEvents = message.render_events === true
      let restoreCompleted = false
      const completeRestore = () => {
        if (restoreCompleted) return
        restoreCompleted = true
        restored = true
        if (controlSocket.readyState === controlSocket.OPEN) {
          controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
        }
        for (const output of pendingOutput.splice(0)) {
          deliverOutput(output.chunk, output.acknowledge)
        }
        if (!renderEvents) onResize?.(requestedSize.cols, requestedSize.rows)
        flushInput()
      }
      const size =
        Number.isInteger(message.cols) &&
        (message.cols ?? 0) > 0 &&
        Number.isInteger(message.rows) &&
        (message.rows ?? 0) > 0
          ? { cols: message.cols as number, rows: message.rows as number }
          : undefined
      onRestore(message.snapshot, completeRestore, size)
    }
  }

  return {
    dispose() {
      disposed = true
      pendingInput.length = 0
      ioSocket.close()
      controlSocket.close()
    },
    resize(cols, rows, pixelWidth, pixelHeight) {
      requestedSize = { cols, rows }
      pendingResize = { cols, rows }
      if (pixelWidth !== undefined) pendingResize.pixelWidth = pixelWidth
      if (pixelHeight !== undefined) pendingResize.pixelHeight = pixelHeight
      sendResize()
    },
    sendBinaryInput(chunk) {
      sendInput(chunk, true)
    },
    sendInput(chunk, userInput = true) {
      sendInput(chunk, false, userInput)
    },
  }
}
