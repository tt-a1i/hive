import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { buildDispatchMessagePayload } from './dispatch-message-payload.js'
import type { DispatchMessageStore } from './dispatch-message-store.js'

export const createDispatchMessageOutbox = (ports: {
  messages: DispatchMessageStore
  runtime: AgentRuntime
  isClosing: () => boolean
}) => {
  const draining = new Set<string>()
  const rerunRequested = new Set<string>()
  const canDeliver = (message: DispatchMessageRecord) => {
    if (ports.isClosing()) return false
    const current = ports.messages.getMessage(message.workspaceId, message.id)
    if (current?.deliveryState !== 'delivering') return false
    if (!ports.messages.isEligible(message.id)) {
      ports.messages.cancel(message.id)
      return false
    }
    return true
  }
  const drainTarget = async (workspaceId: string, targetAgentId: string) => {
    const key = `${workspaceId}:${targetAgentId}`
    if (draining.has(key)) {
      rerunRequested.add(key)
      return
    }
    draining.add(key)
    try {
      while (!ports.isClosing()) {
        const run = ports.runtime.getActiveRunByAgentId(workspaceId, targetAgentId)
        if (!run) return
        const message = ports.messages.listQueued(workspaceId, targetAgentId)[0]
        if (!message) return
        if (!ports.messages.claim(message.id)) continue
        if (!canDeliver(message)) continue
        try {
          if (run.postStartInputReady) await run.postStartInputReady
          if (ports.isClosing()) return
          if (!canDeliver(message)) continue
          await ports.runtime.deliverSystemMessageToAgent(
            workspaceId,
            targetAgentId,
            buildDispatchMessagePayload(
              message,
              ports.messages.requiredSeenSeq(message.dispatchId, message.recipientAgentId)
            ),
            { requireActiveRun: true, beforeWrite: () => canDeliver(message) }
          )
          if (ports.isClosing()) return
          ports.messages.delivered(message.id)
        } catch (error) {
          if (ports.isClosing()) return
          ports.messages.failed(message.id, error instanceof Error ? error.message : String(error))
          return // retry on next explicit drain/start; never spin on a failed PTY
        }
      }
    } finally {
      draining.delete(key)
      if (rerunRequested.delete(key) && !ports.isClosing()) {
        void drainTarget(workspaceId, targetAgentId).catch((error) => {
          if (!ports.isClosing()) console.error('[hive] dispatch message retry failed', error)
        })
      }
    }
  }
  return (workspaceId: string, targetAgentId?: string): void => {
    if (ports.isClosing()) return
    const targets = targetAgentId
      ? [targetAgentId]
      : [
          ...new Set(
            ports.messages.listQueued(workspaceId).map((message) => message.recipientAgentId)
          ),
        ]
    for (const target of targets)
      void drainTarget(workspaceId, target).catch((error) => {
        if (!ports.isClosing()) console.error('[hive] dispatch message delivery failed', error)
      })
  }
}
