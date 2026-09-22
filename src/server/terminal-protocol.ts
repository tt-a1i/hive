type TerminalControlClientMessage =
  | { type: 'output_ack'; bytes: number }
  | { type: 'resize'; cols: number; rows: number; pixelWidth?: number; pixelHeight?: number }
  | { type: 'restore_complete' }
  | { type: 'stop' }

type TerminalControlServerMessage =
  | { type: 'error'; message: string; code?: 'terminal_refresh_required' }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string; cols?: number; rows?: number; render_events?: boolean }

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
  if (
    parsed.type === 'resize' &&
    resizeCols !== undefined &&
    resizeRows !== undefined &&
    resizeCols > 0 &&
    resizeRows > 0
  ) {
    // ConPTY dimensions use signed 16-bit coordinates. Bound total visible
    // cells separately so a valid pair cannot demand an enormous xterm grid.
    if (resizeCols > 32767 || resizeRows > 32767 || resizeCols * resizeRows > 1_000_000) {
      throw new RangeError('Terminal grid exceeds supported dimensions')
    }
    const message: TerminalControlClientMessage = {
      type: 'resize',
      cols: resizeCols,
      rows: resizeRows,
    }
    const parsedPixelWidth = asInteger(pixelWidth)
    const parsedPixelHeight = asInteger(pixelHeight)
    if (parsedPixelWidth !== undefined && parsedPixelWidth >= 0) {
      message.pixelWidth = parsedPixelWidth
    }
    if (parsedPixelHeight !== undefined && parsedPixelHeight >= 0) {
      message.pixelHeight = parsedPixelHeight
    }
    return message
  }

  throw new Error('Invalid terminal control message')
}

export const serializeTerminalError = (
  message: string,
  code?: 'terminal_refresh_required'
): string => {
  return JSON.stringify({
    type: 'error',
    message,
    ...(code && { code }),
  } satisfies TerminalControlServerMessage)
}

export const serializeTerminalExit = (code: number | null): string => {
  return JSON.stringify({ type: 'exit', code } satisfies TerminalControlServerMessage)
}

export const serializeTerminalRestore = (
  snapshot: string,
  size?: { cols: number; rows: number; render_events: boolean }
): string => {
  return JSON.stringify({
    type: 'restore',
    snapshot,
    ...size,
  } satisfies TerminalControlServerMessage)
}

export const parseTerminalRenderInput = (raw: string) => {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (
    value.type !== 'input' ||
    typeof value.data !== 'string' ||
    (value.encoding !== undefined && value.encoding !== 'binary')
  ) {
    throw new Error('Invalid terminal input event')
  }
  const size = parseTerminalControlMessage(
    JSON.stringify({ type: 'resize', cols: value.cols, rows: value.rows })
  )
  if (size.type !== 'resize') throw new Error('Invalid terminal input size')
  return {
    data: value.encoding === 'binary' ? Buffer.from(value.data, 'latin1') : value.data,
    cols: size.cols,
    rows: size.rows,
    userInput: value.user_input !== false,
  }
}

export type { TerminalControlClientMessage, TerminalControlServerMessage }
