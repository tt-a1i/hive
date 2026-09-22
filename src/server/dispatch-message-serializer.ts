import type { DispatchMessageRecord } from '../shared/team-collaboration.js'

export const serializeDispatchMessage = (message: DispatchMessageRecord) => ({
  id: message.id,
  workspace_id: message.workspaceId,
  dispatch_id: message.dispatchId,
  source_dispatch_id: message.sourceDispatchId,
  sequence: message.sequence,
  from_agent_id: message.fromAgentId,
  recipient_agent_id: message.recipientAgentId,
  kind: message.kind,
  reply_to: message.replyTo,
  text: message.text,
  created_at: message.createdAt,
  delivery_state: message.deliveryState,
  delivered_at: message.deliveredAt,
  delivery_error: message.deliveryError,
})

export const serializeDispatchMessagesResult = (
  result: import('../shared/team-collaboration.js').DispatchMessagesResult
) => ({
  member_profile: result.memberProfile,
  dispatch_id: result.dispatchId,
  root_dispatch_id: result.rootDispatchId,
  required_seen_seq: result.requiredSeenSeq,
  messages: result.messages.map(serializeDispatchMessage),
  related_dispatches: result.relatedDispatches.map((dispatch) => ({
    id: dispatch.id,
    parent_dispatch_id: dispatch.parentDispatchId,
    root_dispatch_id: dispatch.rootDispatchId,
    to_agent_id: dispatch.toAgentId,
    owner_name: dispatch.ownerName,
    state: dispatch.state,
    outcome: dispatch.outcome ?? null,
    delegated_from_id: dispatch.delegatedFromId ?? null,
    text: dispatch.text,
  })),
})
