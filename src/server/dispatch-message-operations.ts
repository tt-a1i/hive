import type {
  DispatchMessagesResult,
  SendDispatchMessageInput,
} from '../shared/team-collaboration.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import type { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import { createDispatchMessageOutbox } from './dispatch-message-outbox.js'
import { authorizeDispatchMessage, dispatchRoot } from './dispatch-message-policy.js'
import type { DispatchMessageStore } from './dispatch-message-store.js'
import { createDispatchQuestionOperations } from './dispatch-question-operations.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import { createMailboxStore } from './mailbox-store.js'
import type { Database } from './sqlite.js'
import type { WorkspaceStore } from './workspace-store.js'

export const createDispatchMessageOperations = (ports: {
  db: Database
  ledger: ReturnType<typeof createDispatchLedgerStore>
  messages: DispatchMessageStore
  workspace: WorkspaceStore
  runtime: AgentRuntime
  isClosing: () => boolean
}) => {
  const drainDispatchMessageOutbox = createDispatchMessageOutbox({
    messages: ports.messages,
    runtime: ports.runtime,
    isClosing: ports.isClosing,
  })
  const getDispatchCollaboration = (workspaceId: string, dispatchId: string) => {
    const dispatch = ports.ledger.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new ConflictError('Dispatch does not exist in this workspace')
    const rootDispatchId = dispatchRoot(dispatch)
    const names = new Map(
      ports.workspace.listWorkers(workspaceId).map((worker) => [worker.id, worker.name])
    )
    return {
      rootDispatchId,
      relatedDispatches: ports.ledger
        .listRelatedDispatches(workspaceId, rootDispatchId)
        .map((item) => ({
          id: item.id,
          rootDispatchId,
          parentDispatchId: item.parentDispatchId ?? null,
          toAgentId: item.toAgentId,
          ownerName: names.get(item.toAgentId) ?? item.toAgentId,
          state: item.status,
          outcome: item.outcome ?? null,
          delegatedFromId: item.delegatedFromId ?? null,
          text: item.text,
        })),
    }
  }
  return {
    ...createMailboxStore(ports.db),
    listCollaborationPeers(workspaceId: string) {
      return ports.workspace.listWorkers(workspaceId).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        description: worker.description,
        status: worker.status,
        dispatches: (
          ports.db
            .prepare(`SELECT id, status, outcome FROM dispatches
          WHERE workspace_id = ? AND to_agent_id = ? AND status != 'cancelled'
          ORDER BY sequence DESC LIMIT 5`)
            .all(workspaceId, worker.id) as { id: string; status: string; outcome: string | null }[]
        ).map((dispatch) => ({
          id: dispatch.id,
          state: dispatch.status,
          outcome: dispatch.outcome,
        })),
      }))
    },
    ...createDispatchQuestionOperations({
      hasAgent: ports.workspace.hasAgent,
      getDispatch: ports.ledger.getDispatch,
      getAgent: ports.workspace.getAgent,
      messages: ports.messages,
    }),
    drainDispatchMessageOutbox,
    getDispatchCollaboration,
    listCollaborationMessageHistory(
      workspaceId: string,
      dispatchId: string,
      afterMessageId?: string,
      limit = 101
    ) {
      const { rootDispatchId } = getDispatchCollaboration(workspaceId, dispatchId)
      return ports.messages.listRootMessageHistory(
        workspaceId,
        rootDispatchId,
        afterMessageId,
        limit
      )
    },
    listWorkspaceDispatchMessages: ports.messages.listWorkspaceMessages,
    listActionableDispatchMessages: ports.messages.listActionableWorkspaceMessages,
    listRecentDispatchMessages: ports.messages.listRecentMessages,
    listDispatchMessageHistory: ports.messages.listMessageHistory,
    sendDispatchMessage(workspaceId: string, fromAgentId: string, input: SendDispatchMessageInput) {
      const message = ports.db.transaction(() => {
        const { source, recipientAgentId } = authorizeDispatchMessage(
          {
            hasAgent: ports.workspace.hasAgent,
            getDispatch: ports.ledger.getDispatch,
            getAgent: ports.workspace.getAgent,
            messages: ports.messages,
          },
          workspaceId,
          fromAgentId,
          input
        )
        return ports.messages.insert({
          workspaceId,
          dispatchId: input.dispatchId,
          sourceDispatchId: source?.id ?? null,
          fromAgentId,
          recipientAgentId,
          kind: input.kind,
          replyTo: input.replyTo ?? null,
          text: input.text,
        })
      })()
      drainDispatchMessageOutbox(workspaceId, message.recipientAgentId)
      return ports.messages.getMessage(workspaceId, message.id) ?? message
    },
    listDispatchMessages(
      workspaceId: string,
      agentId: string,
      dispatchId: string,
      afterSeq = 0
    ): DispatchMessagesResult {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
        throw new BadRequestError('after_seq must be a nonnegative integer')
      const actor = ports.workspace.getAgent(workspaceId, agentId)
      const dispatch = ports.ledger.getDispatch(workspaceId, dispatchId)
      if (!dispatch) throw new ConflictError('Dispatch does not exist in this workspace')
      const rootDispatchId = dispatchRoot(dispatch)
      const related = ports.ledger.listRelatedDispatches(workspaceId, rootDispatchId)
      if (actor.role !== 'orchestrator' && !related.some((item) => item.toAgentId === actor.id)) {
        throw new ForbiddenError('You do not participate in this collaboration')
      }
      drainDispatchMessageOutbox(workspaceId, agentId)
      return {
        memberProfile: {
          id: actor.id,
          name: actor.name,
          role: actor.role,
          description: actor.description,
        },
        dispatchId,
        rootDispatchId,
        requiredSeenSeq: ports.messages.requiredSeenSeq(dispatchId, dispatch.toAgentId),
        messages: ports.messages.listMessages(workspaceId, dispatchId, afterSeq),
        relatedDispatches: getDispatchCollaboration(workspaceId, dispatchId).relatedDispatches,
      }
    },
  }
}
export type DispatchMessageOperations = ReturnType<typeof createDispatchMessageOperations>
