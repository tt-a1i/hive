import type { AgentRuntime } from './agent-runtime-contract.js'
import type { ReportOutboxEntry, ReportOutboxStore } from './report-outbox-store.js'

export const createReportOutboxDelivery = (ports: {
  outbox: ReportOutboxStore
  runtime: AgentRuntime
  isClosing: () => boolean
  recordBytes?: (dispatchId: string, bytes: number) => void
}) => {
  const batches = new Map<
    string,
    { entries: Map<number, ReportOutboxEntry>; timer: ReturnType<typeof setTimeout> }
  >()
  const reserved = new Set<number>()
  return (workspaceId: string, targetAgentId = `${workspaceId}:orchestrator`) => {
    if (ports.isClosing() || !ports.runtime.getActiveRunByAgentId(workspaceId, targetAgentId))
      return { attempted: 0, firstSyncError: null as string | null }
    const pending = ports.outbox
      .listPending(workspaceId, targetAgentId)
      .filter((entry) => !reserved.has(entry.id))
    if (!pending.length) return { attempted: 0, firstSyncError: null as string | null }
    const key = `${workspaceId}:${targetAgentId}`
    let batch = batches.get(key)
    if (!batch) {
      const entries = new Map<number, ReportOutboxEntry>()
      const timer = setTimeout(() => {
        batches.delete(key)
        if (ports.isClosing()) {
          for (const id of entries.keys()) reserved.delete(id)
          return
        }
        let included: ReportOutboxEntry[] = []
        const payload = () => {
          if (ports.isClosing()) return undefined
          const current = new Set(
            ports.outbox.listPending(workspaceId, targetAgentId).map((entry) => entry.id)
          )
          included = [...entries.values()].filter((entry) => current.has(entry.id))
          return included.length ? included.map((entry) => entry.payload).join('\n\n') : undefined
        }
        const finish = () => {
          for (const id of entries.keys()) reserved.delete(id)
        }
        try {
          void ports.runtime
            .deliverSystemMessageToAgent(workspaceId, targetAgentId, payload, {
              requireActiveRun: true,
              metadata: () => ({
                kind: 'report_batch',
                dispatchIds: included
                  .map((entry) => entry.dispatchId)
                  .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id)),
              }),
              onWrittenBytes: (bytes) => {
                if (ports.isClosing()) return
                included.forEach((entry, index) => {
                  if (entry.payload.startsWith('<hive-message kind="report"'))
                    ports.recordBytes?.(
                      entry.dispatchId,
                      Math.floor(bytes / included.length) +
                        (index < bytes % included.length ? 1 : 0)
                    )
                })
              },
            })
            .then(() => {
              if (!ports.isClosing())
                for (const entry of included) ports.outbox.markDelivered(entry.id)
            })
            .catch((error) => {
              if (!ports.isClosing()) console.error('[hive] report outbox delivery failed', error)
            })
            .finally(finish)
        } catch (error) {
          finish()
          if (!ports.isClosing()) console.error('[hive] report outbox delivery failed', error)
        }
      }, 350)
      timer.unref?.()
      batch = { entries, timer }
      batches.set(key, batch)
    }
    for (const entry of pending) {
      reserved.add(entry.id)
      batch.entries.set(entry.id, entry)
    }
    return { attempted: pending.length, firstSyncError: null as string | null }
  }
}
