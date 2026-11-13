const TERMINAL_OUTPUT_MIN_RENDER_INTERVAL_MS = 50
const TERMINAL_WRITE_STALL_TIMEOUT_MS = 10_000
const MAX_PENDING_CHARS = 256 * 1024
const MAX_PENDING_ITEMS = 1024

type AcknowledgeTerminalOutput = (bytes: number) => void
type RenderItem =
  | { kind: 'output'; chunk: string; bytes: number; acknowledge: AcknowledgeTerminalOutput }
  | { kind: 'resize'; cols: number; rows: number }

interface TerminalOutputRenderQueueOptions {
  onOverflow: () => void
  write: (chunk: string, callback: () => void) => void
  resize?: (cols: number, rows: number, callback: () => void) => void
}

export interface TerminalOutputRenderQueue {
  dispose: () => void
  enqueue: (chunk: string, bytes: number, acknowledge: AcknowledgeTerminalOutput) => void
  enqueueResize: (cols: number, rows: number) => void
  flush: () => void
}

export const createTerminalOutputRenderQueue = ({
  onOverflow,
  write,
  resize,
}: TerminalOutputRenderQueueOptions): TerminalOutputRenderQueue => {
  let disposed = false
  let writing = false
  let lastFlushAt: number | null = null
  let flushTimer: number | undefined
  let stallTimer: number | undefined
  const pending: RenderItem[] = []
  let pendingChars = 0

  const overflow = () => {
    disposed = true
    if (flushTimer !== undefined) window.clearTimeout(flushTimer)
    if (stallTimer !== undefined) window.clearTimeout(stallTimer)
    pending.length = 0
    pendingChars = 0
    onOverflow()
  }

  const ack = (items: RenderItem[]) => {
    for (const item of items) {
      if (item.kind === 'output' && item.bytes > 0) {
        const bytes = item.bytes
        item.bytes = 0
        item.acknowledge(bytes)
      }
    }
  }
  const schedule = () => {
    if (disposed || writing || flushTimer !== undefined || pending.length === 0) return
    const delay =
      pending[0]?.kind === 'resize' || lastFlushAt === null
        ? 0
        : Math.max(0, TERMINAL_OUTPUT_MIN_RENDER_INTERVAL_MS - (Date.now() - lastFlushAt))
    if (delay === 0) flush()
    else
      flushTimer = window.setTimeout(() => {
        flushTimer = undefined
        flush()
      }, delay)
  }
  function flush() {
    if (flushTimer !== undefined) window.clearTimeout(flushTimer)
    flushTimer = undefined
    if (disposed || writing || pending.length === 0) return
    const first = pending.shift()
    if (!first) return
    const batch = [first]
    if (first.kind === 'output') {
      pendingChars -= first.chunk.length
      while (pending[0]?.kind === 'output') {
        const next = pending.shift() as Extract<RenderItem, { kind: 'output' }>
        pendingChars -= next.chunk.length
        batch.push(next)
      }
    }
    writing = true
    lastFlushAt = first.kind === 'resize' ? null : Date.now()
    let completed = false
    const complete = () => {
      if (completed || disposed) return
      completed = true
      if (stallTimer !== undefined) window.clearTimeout(stallTimer)
      stallTimer = undefined
      writing = false
      ack(batch)
      schedule()
    }
    stallTimer = window.setTimeout(overflow, TERMINAL_WRITE_STALL_TIMEOUT_MS)
    if (first.kind === 'resize') {
      // A geometry barrier drains xterm's native write queue and must never
      // advance on a timeout, even when a preceding byte ACK has timed out.
      if (resize) resize(first.cols, first.rows, complete)
      else complete()
    } else {
      write(batch.map((item) => (item.kind === 'output' ? item.chunk : '')).join(''), complete)
    }
  }
  return {
    dispose() {
      disposed = true
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      if (stallTimer !== undefined) window.clearTimeout(stallTimer)
      pending.length = 0
      pendingChars = 0
    },
    enqueue(chunk, bytes, acknowledge) {
      if (disposed) return
      if (!chunk.length) {
        acknowledge(bytes)
        return
      }
      const last = pending.at(-1)
      const merges = last?.kind === 'output' && last.acknowledge === acknowledge
      if (
        pendingChars + chunk.length > MAX_PENDING_CHARS ||
        (!merges && pending.length >= MAX_PENDING_ITEMS)
      ) {
        overflow()
        return
      }
      pendingChars += chunk.length
      if (last?.kind === 'output' && merges) {
        last.chunk += chunk
        last.bytes += bytes
      } else pending.push({ kind: 'output', chunk, bytes, acknowledge })
      schedule()
    },
    enqueueResize(cols, rows) {
      if (disposed) return
      const last = pending.at(-1)
      if (last?.kind !== 'resize' && pending.length >= MAX_PENDING_ITEMS) {
        overflow()
        return
      }
      if (last?.kind === 'resize') {
        last.cols = cols
        last.rows = rows
      } else pending.push({ kind: 'resize', cols, rows })
      schedule()
    },
    flush,
  }
}
