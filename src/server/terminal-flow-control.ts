import type { Socket } from 'node:net'

import type WebSocket from 'ws'

export const FLOW_CONTROL = {
  BATCH_INTERVAL_MS: 4,
  LOW_LATENCY_THRESHOLD_BYTES: 256,
  WS_BUFFERED_HIGH_WATER: 16 * 1024,
  WS_BUFFERED_LOW_WATER: 8 * 1024,
  UNACKED_HIGH_WATER: 100 * 1024,
  UNACKED_LOW_WATER: 50 * 1024,
} as const

const LOW_LATENCY_IDLE_WINDOW_MS = 5
const RESUME_CHECK_INTERVAL_MS = 16

interface TerminalOutputFlowOptions {
  onBackpressureChange: (backpressured: boolean) => void
}

export interface TerminalOutputFlow {
  ack: (bytes: number) => void
  close: () => void
  enqueue: (chunk: string) => void
}

const getTransportSocket = (ws: WebSocket): Socket | null => {
  return ((ws as WebSocket & { _socket?: Socket })._socket ?? null) as Socket | null
}

const byteLength = (chunk: string) => Buffer.byteLength(chunk, 'utf8')

export const createTerminalOutputFlow = (
  ws: WebSocket,
  { onBackpressureChange }: TerminalOutputFlowOptions
): TerminalOutputFlow => {
  let closed = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let lastSentAt = 0
  let pendingChunks: string[] = []
  let resumeCheckTimer: ReturnType<typeof setTimeout> | null = null
  let paused = false
  let unackedBytes = 0

  const shouldPause = () => {
    return (
      ws.bufferedAmount >= FLOW_CONTROL.WS_BUFFERED_HIGH_WATER ||
      unackedBytes >= FLOW_CONTROL.UNACKED_HIGH_WATER
    )
  }

  const canResume = () => {
    return (
      ws.bufferedAmount < FLOW_CONTROL.WS_BUFFERED_LOW_WATER &&
      unackedBytes < FLOW_CONTROL.UNACKED_LOW_WATER
    )
  }

  const clearResumeCheck = () => {
    if (resumeCheckTimer) clearTimeout(resumeCheckTimer)
    resumeCheckTimer = null
    getTransportSocket(ws)?.removeListener('drain', checkResume)
  }

  const scheduleResumeCheck = () => {
    if (!paused || closed) return
    clearResumeCheck()
    getTransportSocket(ws)?.once('drain', checkResume)
    resumeCheckTimer = setTimeout(checkResume, RESUME_CHECK_INTERVAL_MS)
  }

  const checkResume = () => {
    if (!paused || closed) {
      clearResumeCheck()
      return
    }
    if (canResume()) {
      paused = false
      clearResumeCheck()
      onBackpressureChange(false)
      return
    }
    scheduleResumeCheck()
  }

  const afterSend = (bytes: number) => {
    if (closed || paused) return
    unackedBytes += bytes
    if (shouldPause()) {
      paused = true
      onBackpressureChange(true)
      scheduleResumeCheck()
    }
  }

  const sendChunk = (chunk: string) => {
    if (closed || ws.readyState !== ws.OPEN) return
    ws.send(chunk)
    lastSentAt = Date.now()
    afterSend(byteLength(chunk))
  }

  const flush = () => {
    flushTimer = null
    if (pendingChunks.length === 0) return
    const chunk = pendingChunks.join('')
    pendingChunks = []
    sendChunk(chunk)
  }

  return {
    ack(bytes) {
      unackedBytes = Math.max(0, unackedBytes - Math.max(0, Math.floor(bytes)))
      checkResume()
    },
    close() {
      closed = true
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      clearResumeCheck()
      if (paused) {
        paused = false
        onBackpressureChange(false)
      }
      pendingChunks = []
    },
    enqueue(chunk) {
      if (closed) return
      const now = Date.now()
      const isLowLatency =
        pendingChunks.length === 0 &&
        flushTimer === null &&
        byteLength(chunk) < FLOW_CONTROL.LOW_LATENCY_THRESHOLD_BYTES &&
        now - lastSentAt >= LOW_LATENCY_IDLE_WINDOW_MS
      if (isLowLatency) {
        sendChunk(chunk)
        return
      }
      pendingChunks.push(chunk)
      if (!flushTimer) flushTimer = setTimeout(flush, FLOW_CONTROL.BATCH_INTERVAL_MS)
    },
  }
}
