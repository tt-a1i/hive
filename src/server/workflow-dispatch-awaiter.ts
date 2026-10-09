import { MAX_WORKFLOW_DURATION_MS } from './workflow-script-loader.js'

export interface ReportPayload {
  text: string
  artifacts: string[]
  status?: string
}

interface Pending {
  resolve: (payload: ReportPayload) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface WorkflowDispatchAwaiter {
  awaitReport(dispatchId: string, timeoutMs?: number): Promise<ReportPayload>
  notifyReport(dispatchId: string, payload: ReportPayload): void
  notifyCancel(dispatchId: string, reason: string): void
  forceCancel(dispatchId: string, reason: string): void
  cancelAll(reason: string): void
}

// Default 10 minutes — workflows often run long. Callers may shorten via opts.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_DEFERRED_EVENT_TTL_MS = DEFAULT_TIMEOUT_MS
const DEFAULT_MAX_DEFERRED_EVENTS = 4096

interface DeferredEvent<T> {
  value: T
  expiresAt: number
}

export interface WorkflowDispatchAwaiterOptions {
  deferredEventTtlMs?: number
  maxDeferredEvents?: number
  now?: () => number
}

export const createWorkflowDispatchAwaiter = (
  options: WorkflowDispatchAwaiterOptions = {}
): WorkflowDispatchAwaiter => {
  const pending = new Map<string, Pending>()
  // TIER 2 #10 — deferred-cancel state. The runner creates a dispatch
  // and THEN calls awaitReport, with at least one microtask gap between
  // the two. If notifyCancel(id) fires in that gap, it currently hits
  // an empty `pending` map and no-ops; the subsequent awaitReport(id)
  // then waits the full DEFAULT_TIMEOUT_MS (10 min) on a dispatch that
  // is already cancelled. Remembering the cancel intent here lets
  // awaitReport reject synchronously the instant it gets registered.
  // We also remember any pre-arrived report payload for the same
  // reason — defensive against a future ordering change.
  const cancelledIds = new Map<string, DeferredEvent<string>>()
  const reportedIds = new Map<string, DeferredEvent<ReportPayload>>()
  const now = options.now ?? (() => Date.now())
  const deferredEventTtlMs =
    typeof options.deferredEventTtlMs === 'number' && options.deferredEventTtlMs > 0
      ? options.deferredEventTtlMs
      : DEFAULT_DEFERRED_EVENT_TTL_MS
  const maxDeferredEvents =
    typeof options.maxDeferredEvents === 'number' && options.maxDeferredEvents > 0
      ? options.maxDeferredEvents
      : DEFAULT_MAX_DEFERRED_EVENTS

  const take = (dispatchId: string) => {
    const entry = pending.get(dispatchId)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(dispatchId)
    }
    return entry
  }

  const pruneDeferredEvents = () => {
    const time = now()
    for (const [id, entry] of cancelledIds) {
      if (entry.expiresAt <= time) cancelledIds.delete(id)
    }
    for (const [id, entry] of reportedIds) {
      if (entry.expiresAt <= time) reportedIds.delete(id)
    }
    while (cancelledIds.size + reportedIds.size > maxDeferredEvents) {
      const reportedKey = reportedIds.keys().next().value
      if (typeof reportedKey === 'string') {
        reportedIds.delete(reportedKey)
        continue
      }
      const cancelledKey = cancelledIds.keys().next().value
      if (typeof cancelledKey === 'string') {
        cancelledIds.delete(cancelledKey)
        continue
      }
      break
    }
  }

  const putDeferred = <T>(map: Map<string, DeferredEvent<T>>, dispatchId: string, value: T) => {
    map.set(dispatchId, { value, expiresAt: now() + deferredEventTtlMs })
    pruneDeferredEvents()
  }

  const takeDeferred = <T>(
    map: Map<string, DeferredEvent<T>>,
    dispatchId: string
  ): T | undefined => {
    pruneDeferredEvents()
    const entry = map.get(dispatchId)
    if (!entry) return undefined
    map.delete(dispatchId)
    return entry.value
  }

  return {
    awaitReport(dispatchId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<ReportPayload>((resolve, reject) => {
        // Pre-arrived events: drain immediately, no timer / no entry.
        const earlyReport = takeDeferred(reportedIds, dispatchId)
        if (earlyReport) {
          resolve(earlyReport)
          return
        }
        const earlyCancel = takeDeferred(cancelledIds, dispatchId)
        if (earlyCancel !== undefined) {
          reject(new Error(`workflow dispatch ${dispatchId} cancelled: ${earlyCancel}`))
          return
        }
        // The enclosing workflow is already capped at this duration. Avoid
        // Node turning a larger finite agent delay into a 1ms timeout.
        const delay = Number.isFinite(timeoutMs)
          ? Math.min(timeoutMs, MAX_WORKFLOW_DURATION_MS)
          : timeoutMs
        const timer = setTimeout(() => {
          pending.delete(dispatchId)
          reject(new Error(`workflow dispatch ${dispatchId} timeout after ${timeoutMs}ms`))
        }, delay)
        pending.set(dispatchId, { resolve, reject, timer })
      })
    },
    notifyReport(dispatchId, payload) {
      const entry = take(dispatchId)
      if (entry) {
        entry.resolve(payload)
      } else {
        // Pre-arrival: stash for the eventual awaitReport call. Cap
        // stash size and TTL so unknown ids cannot grow forever.
        putDeferred(reportedIds, dispatchId, payload)
      }
    },
    notifyCancel(dispatchId, reason) {
      const entry = take(dispatchId)
      if (entry) {
        entry.reject(new Error(`workflow dispatch ${dispatchId} cancelled: ${reason}`))
      } else {
        putDeferred(cancelledIds, dispatchId, reason)
      }
    },
    forceCancel(dispatchId, reason) {
      cancelledIds.delete(dispatchId)
      reportedIds.delete(dispatchId)
      const entry = take(dispatchId)
      if (entry) {
        entry.reject(new Error(`workflow dispatch ${dispatchId} cancelled: ${reason}`))
      }
    },
    cancelAll(reason) {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`workflow dispatch ${id} cancelled: ${reason}`))
      }
      pending.clear()
      // cancelAll happens at runtime close — anything waiting at that
      // moment should fail loudly, but the deferred state can be
      // safely dropped since no future awaitReport will run.
      cancelledIds.clear()
      reportedIds.clear()
    },
  }
}
