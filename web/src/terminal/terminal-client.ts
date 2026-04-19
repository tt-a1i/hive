type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string }

interface TerminalClientOptions {
  onError: (message: string) => void
  onExit: (code: number | null) => void
  onOutput: (chunk: string) => void
  onRestore: (snapshot: string) => void
  runId: string
}

export interface TerminalClient {
  dispose: () => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendInput: (chunk: string) => void
}

const toWebSocketUrl = (path: string) => {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export const createTerminalClient = ({
  onError,
  onExit,
  onOutput,
  onRestore,
  runId,
}: TerminalClientOptions): TerminalClient => {
  const ioSocket = new WebSocket(toWebSocketUrl(`/ws/terminal/${runId}/io`))
  const controlSocket = new WebSocket(toWebSocketUrl(`/ws/terminal/${runId}/control`))

  ioSocket.onmessage = (event) => {
    onOutput(typeof event.data === 'string' ? event.data : '')
  }
  controlSocket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as TerminalControlServerMessage
    if (message.type === 'exit') onExit(message.code)
    if (message.type === 'error') onError(message.message)
    if (message.type === 'restore') {
      onRestore(message.snapshot)
      if (controlSocket.readyState === controlSocket.OPEN) {
        controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
      }
    }
  }

  return {
    dispose() {
      ioSocket.close()
      controlSocket.close()
    },
    resize(cols, rows, pixelWidth, pixelHeight) {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'resize', cols, rows, pixelWidth, pixelHeight }))
    },
    sendInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      ioSocket.send(chunk)
    },
  }
}
