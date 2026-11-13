import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { buildDispatchMessagePayload } from './dispatch-message-payload.js'
import type { DispatchMessageStore } from './dispatch-message-store.js'

export const createDispatchMessageOutbox = (ports: {
  messages: DispatchMessageStore
  runtime: AgentRuntime
  isClosing: () => boolean
}) => {
  let closed = false
  const retryTimers = new Map<string, NodeJS.Timeout>()
  const isClosing = () => closed || ports.isClosing()
  const draining = new Set<string>()
  const rerunRequested = new Set<string>()
  const canDeliver = (message: DispatchMessageRecord) => {
    if (isClosing()) return false
    const current = ports.messages.getMessage(message.workspaceId, message.id)
    if (current?.deliveryState !== 'delivering') return false
    if (!ports.messages.isEligible(message.id)) {
      ports.messages.cancel(message.id)
      return false
    }
    return true
  }
  const drainTarget = async (
    workspaceId: string,
    targetAgentId: string,
    attempt = 0,
    retryMessageId?: string
  ) => {
    const key = `${workspaceId}:${targetAgentId}`
    if (draining.has(key)) {
      rerunRequested.add(key)
      return
    }
    draining.add(key)
    let deliveryFailed = false
    try {
      while (!isClosing()) {
        const run = ports.runtime.getActiveRunByAgentId(workspaceId, targetAgentId)
        if (!run) return
        const message = ports.messages.listQueued(workspaceId, targetAgentId)[0]
        if (!message) return
        if (retryMessageId && message.id !== retryMessageId) attempt = 0
        retryMessageId = undefined
        if (!ports.messages.claim(message.id)) continue
        if (!canDeliver(message)) continue
        try {
          if (run.postStartInputReady) await run.postStartInputReady
          if (isClosing()) return
          if (!canDeliver(message)) continue
          await ports.runtime.deliverSystemMessageToAgent(
            workspaceId,
            targetAgentId,
            buildDispatchMessagePayload(
              message,
              ports.messages.requiredSeenSeq(message.dispatchId, message.recipientAgentId)
            ),
            {
              requireActiveRun: true,
              beforeWrite: () => canDeliver(message),
              metadata: { kind: message.kind, dispatchIds: [message.dispatchId] },
            }
          )
          if (isClosing()) return
          ports.messages.delivered(message.id)
          attempt = 0
        } catch (error) {
          if (isClosing()) return
          ports.messages.failed(message.id, error instanceof Error ? error.message : String(error))
          deliveryFailed = true
          const current = ports.messages.getMessage(workspaceId, message.id)
          if (current?.deliveryState === 'queued') {
            if (!ports.messages.isEligible(message.id)) ports.messages.cancel(message.id)
            else if (attempt < 2) {
              const timer = setTimeout(
                () => {
                  retryTimers.delete(key)
                  if (isClosing()) return
                  void drainTarget(workspaceId, targetAgentId, attempt + 1, message.id).catch(
                    (error) => {
                      if (!isClosing()) console.error('[hive] dispatch message retry failed', error)
                    }
                  )
                },
                250 * 2 ** attempt
              )
              timer.unref()
              retryTimers.set(key, timer)
            }
          }
          return // Exhausted messages stay queued for a later explicit drain/start.
        }
      }
    } finally {
      draining.delete(key)
      const rerun = rerunRequested.delete(key)
      if (rerun && !deliveryFailed && !isClosing()) {
        void drainTarget(workspaceId, targetAgentId).catch((error) => {
          if (!isClosing()) console.error('[hive] dispatch message retry failed', error)
        })
      }
    }
  }
  const drain = (workspaceId: string, targetAgentId?: string): void => {
    if (isClosing()) return
    const targets = targetAgentId
      ? [targetAgentId]
      : [
          ...new Set(
            ports.messages.listQueued(workspaceId).map((message) => message.recipientAgentId)
          ),
        ]
    for (const target of targets) {
      const key = `${workspaceId}:${target}`
      clearTimeout(retryTimers.get(key))
      retryTimers.delete(key)
      void drainTarget(workspaceId, target).catch((error) => {
        if (!isClosing()) console.error('[hive] dispatch message delivery failed', error)
      })
    }
  }
  return Object.assign(drain, {
    close: () => {
      closed = true
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      rerunRequested.clear()
    },
  })
}
