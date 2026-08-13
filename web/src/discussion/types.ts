export type DiscussionStatus = 'thinking' | 'discussing' | 'concluding' | 'concluded' | 'cancelled'

export interface DiscussionMember {
  agentId: string
  agentName: string
  initialPosition: string | null
  finalPosition: string | null
  roundsParticipated: number
  modelLabel: string | null
}

export interface DiscussionGroup {
  id: string
  workspaceId: string
  topic: string
  maxRounds: number
  currentRound: number
  status: DiscussionStatus
  orchListen: boolean
  createdBy: string
  createdAt: number
  concludedAt: number | null
  members: DiscussionMember[]
}

export interface DiscussionMessage {
  sequence: number
  groupId: string
  round: number
  fromAgentId: string
  fromAgentName: string
  text: string
  createdAt: number
  modelLabel: string | null
}

export interface DiscussionStateChangeEvent {
  groupId: string
  status: DiscussionStatus
  currentRound: number
}
