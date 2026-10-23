import type { DispatchMessageDeliveryState, DispatchMessageKind } from './team-collaboration.js'

/** Wire shape shared by Action Center and its read-only message history. */
export interface ActionCenterMessage {
  id: string
  workspace_id: string
  dispatch_id: string
  source_dispatch_id: string | null
  sequence: number
  from_agent_id: string
  recipient_agent_id: string
  kind: DispatchMessageKind
  reply_to: string | null
  text: string
  created_at: number
  delivery_state: DispatchMessageDeliveryState
  delivered_at: number | null
  delivery_error: string | null
}

export interface ActionCenterResponsibility {
  id: string
  parent_dispatch_id: string | null
  root_dispatch_id: string
  to_agent_id: string
  owner_name: string
  state: 'queued' | 'submitted' | 'reported' | 'cancelled'
  text: string
}

export interface ActionCenterConversation {
  messages: ActionCenterMessage[]
  related_dispatches: ActionCenterResponsibility[]
  root_dispatch_id: string
  previous_before_message_id: string | null
  next_after_message_id: string | null
}
