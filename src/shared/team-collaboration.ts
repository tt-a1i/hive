export type DispatchMessageKind = 'note' | 'question' | 'answer' | 'progress'
export type DispatchMessageDeliveryState =
  | 'recorded'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'cancelled'

export interface SendDispatchMessageInput {
  dispatchId: string
  sourceDispatchId?: string
  recipient?: 'owner' | 'orchestrator'
  kind: DispatchMessageKind
  replyTo?: string
  text: string
}

export interface DispatchMessageRecord {
  id: string
  workspaceId: string
  dispatchId: string
  sourceDispatchId: string | null
  sequence: number
  fromAgentId: string
  recipientAgentId: string
  kind: DispatchMessageKind
  replyTo: string | null
  text: string
  createdAt: number
  deliveryState: DispatchMessageDeliveryState
  deliveredAt: number | null
  deliveryError: string | null
}

export interface RelatedDispatchSummary {
  outcome?: 'success' | 'failed' | null
  delegatedFromId?: string | null
  id: string
  parentDispatchId: string | null
  rootDispatchId: string
  toAgentId: string
  ownerName: string
  state: 'queued' | 'submitted' | 'reported' | 'cancelled'
  text: string
}

export interface DispatchMessagesResult {
  memberProfile: { id: string; name: string; role: string; description: string }
  dispatchId: string
  rootDispatchId: string
  requiredSeenSeq: number
  messages: DispatchMessageRecord[]
  relatedDispatches: RelatedDispatchSummary[]
}
