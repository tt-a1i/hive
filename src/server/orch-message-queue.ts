/**
 * Per-workspace message queue for external messages targeting the Orchestrator.
 *
 * Messages are batched by priority:
 * - high: failed/blocked reports — bypass batch window, flush immediately
 * - normal: success reports — collected in a 5s batch window, merged into single injection
 *
 * Flush triggers:
 * 1. High priority message arrives → immediate flush of that message only
 * 2. Batch window expires (5s) → merge all pending normal messages into one block
 * 3. User submits input (external flush call) → flush pending after user input
 * 4. Max age fallback (15s) → force flush if batch window somehow missed
 */

const BATCH_WINDOW_MS = 5_000
const FLUSH_MAX_AGE_MS = 15_000
const FLUSH_CHECK_INTERVAL_MS = 2_000

export type MessagePriority = 'normal' | 'high'

interface QueuedMessage {
  text: string
  priority: MessagePriority
  enqueuedAt: number
}

interface WorkspaceQueue {
  messages: QueuedMessage[]
  flushTimer: ReturnType<typeof setInterval> | null
  batchTimer: ReturnType<typeof setTimeout> | null
}

export interface OrchMessageQueue {
  enqueue: (workspaceId: string, text: string, priority?: MessagePriority) => void
  flush: (workspaceId: string) => string[]
  peek: (workspaceId: string) => number
  dispose: () => void
}

const SEPARATOR = '─'.repeat(36)

const mergeBatch = (messages: QueuedMessage[]): string => {
  if (messages.length === 1) return `${SEPARATOR}\n${messages[0]!.text}\n${SEPARATOR}`
  const header = `${SEPARATOR}\n[Hive: ${messages.length} 条新报告]\n`
  return header + messages.map((m) => m.text).join('\n---\n') + `\n${SEPARATOR}`
}

export const createOrchMessageQueue = (
  onFlush: (workspaceId: string, messages: string[]) => void
): OrchMessageQueue => {
  const queues = new Map<string, WorkspaceQueue>()

  const getOrCreateQueue = (workspaceId: string): WorkspaceQueue => {
    let queue = queues.get(workspaceId)
    if (!queue) {
      queue = { messages: [], flushTimer: null, batchTimer: null }
      queues.set(workspaceId, queue)
    }
    return queue
  }

  const startFlushTimer = (workspaceId: string, queue: WorkspaceQueue) => {
    if (queue.flushTimer) return
    queue.flushTimer = setInterval(() => {
      if (queue.messages.length === 0) {
        clearInterval(queue.flushTimer!)
        queue.flushTimer = null
        return
      }
      const oldest = queue.messages[0]!.enqueuedAt
      if (Date.now() - oldest >= FLUSH_MAX_AGE_MS) {
        flushNormal(workspaceId)
      }
    }, FLUSH_CHECK_INTERVAL_MS)
  }

  const startBatchTimer = (workspaceId: string, queue: WorkspaceQueue) => {
    if (queue.batchTimer) return
    queue.batchTimer = setTimeout(() => {
      queue.batchTimer = null
      flushNormal(workspaceId)
    }, BATCH_WINDOW_MS)
  }

  const flushNormal = (workspaceId: string) => {
    const queue = queues.get(workspaceId)
    if (!queue || queue.messages.length === 0) return
    const merged = mergeBatch(queue.messages)
    queue.messages = []
    if (queue.batchTimer) {
      clearTimeout(queue.batchTimer)
      queue.batchTimer = null
    }
    if (queue.flushTimer) {
      clearInterval(queue.flushTimer)
      queue.flushTimer = null
    }
    onFlush(workspaceId, [merged])
  }

  const flush = (workspaceId: string): string[] => {
    const queue = queues.get(workspaceId)
    if (!queue || queue.messages.length === 0) return []
    const merged = mergeBatch(queue.messages)
    queue.messages = []
    if (queue.batchTimer) {
      clearTimeout(queue.batchTimer)
      queue.batchTimer = null
    }
    if (queue.flushTimer) {
      clearInterval(queue.flushTimer)
      queue.flushTimer = null
    }
    return [merged]
  }

  return {
    enqueue(workspaceId, text, priority = 'normal') {
      if (priority === 'high') {
        onFlush(workspaceId, [text])
        return
      }
      const queue = getOrCreateQueue(workspaceId)
      queue.messages.push({ text, priority, enqueuedAt: Date.now() })
      startBatchTimer(workspaceId, queue)
      startFlushTimer(workspaceId, queue)
    },
    flush,
    peek(workspaceId) {
      return queues.get(workspaceId)?.messages.length ?? 0
    },
    dispose() {
      for (const queue of queues.values()) {
        if (queue.flushTimer) clearInterval(queue.flushTimer)
        if (queue.batchTimer) clearTimeout(queue.batchTimer)
      }
      queues.clear()
    },
  }
}
