const TERMINAL_OUTPUT_MIN_RENDER_INTERVAL_MS = 50
const TERMINAL_OUTPUT_WRITE_ACK_TIMEOUT_MS = 1000

type AcknowledgeTerminalOutput = (bytes: number) => void
type RenderItem =
  | { kind: 'output'; chunk: string; bytes: number; acknowledge: AcknowledgeTerminalOutput }
  | { kind: 'resize'; cols: number; rows: number }

interface TerminalOutputRenderQueueOptions {
  canRender: () => boolean
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
  canRender,
  write,
  resize,
}: TerminalOutputRenderQueueOptions): TerminalOutputRenderQueue => {
  let disposed = false
  let writing = false
  let lastFlushAt: number | null = null
  let flushTimer: number | undefined
  let writeTimer: number | undefined
  const pending: RenderItem[] = []

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
    if (!canRender()) {
      ack(pending)
      return
    }
    const first = pending.shift()
    if (!first) return
    const batch = [first]
    if (first.kind === 'output') {
      while (pending[0]?.kind === 'output') batch.push(pending.shift() as RenderItem)
    }
    writing = true
    lastFlushAt = first.kind === 'resize' ? null : Date.now()
    let completed = false
    const complete = () => {
      if (completed || disposed) return
      completed = true
      if (writeTimer !== undefined) window.clearTimeout(writeTimer)
      writeTimer = undefined
      writing = false
      ack(batch)
      schedule()
    }
    if (first.kind === 'resize') {
      // A geometry barrier drains xterm's native write queue and must never
      // advance on a timeout, even when a preceding byte ACK has timed out.
      if (resize) resize(first.cols, first.rows, complete)
      else complete()
    } else {
      writeTimer = window.setTimeout(complete, TERMINAL_OUTPUT_WRITE_ACK_TIMEOUT_MS)
      try {
        write(batch.map((item) => (item.kind === 'output' ? item.chunk : '')).join(''), complete)
      } catch (error) {
        complete()
        throw error
      }
    }
  }
  return {
    dispose() {
      disposed = true
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      if (writeTimer !== undefined) window.clearTimeout(writeTimer)
      pending.length = 0
    },
    enqueue(chunk, bytes, acknowledge) {
      if (disposed) return
      const item: RenderItem = { kind: 'output', chunk, bytes, acknowledge }
      if (!canRender() || !chunk.length) ack([item])
      if (!chunk.length) return
      pending.push(item)
      schedule()
    },
    enqueueResize(cols, rows) {
      if (disposed) return
      pending.push({ kind: 'resize', cols, rows })
      schedule()
    },
    flush,
  }
}
