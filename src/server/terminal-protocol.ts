type TerminalControlClientMessage =
  | { type: 'output_ack'; bytes: number }
  | { type: 'resize'; cols: number; rows: number; pixelWidth?: number; pixelHeight?: number }
  | { type: 'restore_complete' }
  | { type: 'stop' }

type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string }

const asInteger = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export const parseTerminalControlMessage = (raw: Buffer | string): TerminalControlClientMessage => {
  const parsed = JSON.parse(raw.toString()) as { [key: string]: unknown; type?: unknown }
  const { bytes, cols, rows, pixelHeight, pixelWidth } = parsed
  if (parsed.type === 'stop') return { type: 'stop' }
  if (parsed.type === 'restore_complete') return { type: 'restore_complete' }
  const ackBytes = asInteger(bytes)
  if (parsed.type === 'output_ack' && ackBytes !== undefined && ackBytes >= 0) {
    return { type: 'output_ack', bytes: ackBytes }
  }
  const resizeCols = asInteger(cols)
  const resizeRows = asInteger(rows)
  if (parsed.type === 'resize' && resizeCols !== undefined && resizeRows !== undefined) {
    const message: TerminalControlClientMessage = {
      type: 'resize',
      cols: resizeCols,
      rows: resizeRows,
    }
    const parsedPixelWidth = asInteger(pixelWidth)
    const parsedPixelHeight = asInteger(pixelHeight)
    if (parsedPixelWidth !== undefined) message.pixelWidth = parsedPixelWidth
    if (parsedPixelHeight !== undefined) message.pixelHeight = parsedPixelHeight
    return message
  }

  throw new Error('Invalid terminal control message')
}

export const serializeTerminalError = (message: string): string => {
  return JSON.stringify({ type: 'error', message } satisfies TerminalControlServerMessage)
}

export const serializeTerminalExit = (code: number | null): string => {
  return JSON.stringify({ type: 'exit', code } satisfies TerminalControlServerMessage)
}

export const serializeTerminalRestore = (snapshot: string): string => {
  return JSON.stringify({ type: 'restore', snapshot } satisfies TerminalControlServerMessage)
}

export type { TerminalControlClientMessage, TerminalControlServerMessage }
