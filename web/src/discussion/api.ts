import type { DiscussionGroup, DiscussionMember, DiscussionMessage } from './types.js'

interface DiscussionGroupPayload {
  id: string
  workspace_id: string
  topic: string
  max_rounds: number
  current_round: number
  max_messages: number
  message_count: number
  status: DiscussionGroup['status']
  listen_mode: 'db' | 'stdin'
  created_by: string
  created_at: number
  concluded_at: number | null
  members: DiscussionMemberPayload[]
}

interface DiscussionMemberPayload {
  agent_id: string
  agent_name: string
  initial_position: string | null
  final_position: string | null
  rounds_participated: number
  model_label: string | null
}

interface DiscussionMessagePayload {
  sequence: number
  group_id: string
  round: number
  from_agent_id: string
  from_agent_name: string
  text: string
  created_at: number
  model_label: string | null
}

const fromGroupPayload = (p: DiscussionGroupPayload): DiscussionGroup => ({
  id: p.id,
  workspaceId: p.workspace_id,
  topic: p.topic,
  maxRounds: p.max_rounds,
  currentRound: p.current_round,
  status: p.status,
  orchListen: p.listen_mode === 'stdin',
  createdBy: p.created_by,
  createdAt: p.created_at,
  concludedAt: p.concluded_at,
  members: p.members.map(fromMemberPayload),
})

const fromMemberPayload = (p: DiscussionMemberPayload): DiscussionMember => ({
  agentId: p.agent_id,
  agentName: p.agent_name,
  initialPosition: p.initial_position,
  finalPosition: p.final_position,
  roundsParticipated: p.rounds_participated,
  modelLabel: p.model_label,
})

const fromMessagePayload = (p: DiscussionMessagePayload): DiscussionMessage => ({
  sequence: p.sequence,
  groupId: p.group_id,
  round: p.round,
  fromAgentId: p.from_agent_id,
  fromAgentName: p.from_agent_name ?? p.from_agent_id,
  text: p.text,
  createdAt: p.created_at,
  modelLabel: p.model_label,
})

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return response
}

const postJson = (url: string, body: Record<string, unknown>): Promise<Response> =>
  apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getActiveDiscussions = async (workspaceId: string): Promise<DiscussionGroup[]> => {
  const response = await apiFetch(
    `/api/team/discuss/active?workspace_id=${encodeURIComponent(workspaceId)}`
  )
  const payload = (await response.json()) as DiscussionGroupPayload[]
  return payload.map(fromGroupPayload)
}

export const getDiscussionMessages = async (
  workspaceId: string,
  groupId: string
): Promise<DiscussionMessage[]> => {
  const response = await apiFetch(
    `/api/team/discuss/messages?workspace_id=${encodeURIComponent(workspaceId)}&group_id=${encodeURIComponent(groupId)}`
  )
  const payload = (await response.json()) as DiscussionMessagePayload[]
  return payload.map(fromMessagePayload)
}

export interface StartDiscussionInput {
  members: string[]
  topic: string
  rounds?: number
  listenMode?: 'db' | 'stdin'
  templateId?: string
  orchParticipates?: boolean
}

export const startDiscussion = async (
  workspaceId: string,
  input: StartDiscussionInput
): Promise<{ groupId: string }> => {
  const response = await postJson('/api/team/discuss/start', {
    project_id: workspaceId,
    members: input.members,
    topic: input.topic,
    ...(input.rounds ? { rounds: input.rounds } : {}),
    ...(input.listenMode ? { listen_mode: input.listenMode } : {}),
    ...(input.templateId ? { template_id: input.templateId } : {}),
    ...(input.orchParticipates ? { orch_participates: true } : {}),
  })
  const data = (await response.json()) as { group_id: string }
  return { groupId: data.group_id }
}

export const sendDiscussMessage = async (
  workspaceId: string,
  groupId: string,
  text: string
): Promise<void> => {
  await postJson('/api/team/discuss/message', {
    project_id: workspaceId,
    group_id: groupId,
    text,
  })
}

export const concludeDiscussion = async (
  workspaceId: string,
  groupId: string,
  finalPosition: string
): Promise<void> => {
  await postJson('/api/team/discuss/final', {
    project_id: workspaceId,
    group_id: groupId,
    text: finalPosition,
  })
}

export const endDiscussion = async (
  workspaceId: string,
  groupId: string,
  reason?: string,
  cancel?: boolean
): Promise<void> => {
  await postJson('/api/team/discuss/end', {
    project_id: workspaceId,
    group_id: groupId,
    ...(reason ? { reason } : {}),
    ...(cancel ? { cancel: true } : {}),
  })
}

export const skipMember = async (
  workspaceId: string,
  groupId: string,
  workerName: string
): Promise<void> => {
  await postJson('/api/team/discuss/skip', {
    project_id: workspaceId,
    worker_name: workerName,
    group_id: groupId,
  })
}

export const steerDiscussion = async (
  workspaceId: string,
  groupId: string,
  text: string
): Promise<void> => {
  await postJson('/api/team/discuss/steer', {
    project_id: workspaceId,
    group_id: groupId,
    text,
  })
}

export const extendRounds = async (
  workspaceId: string,
  groupId: string,
  rounds?: number
): Promise<void> => {
  await postJson('/api/team/discuss/extend', {
    project_id: workspaceId,
    group_id: groupId,
    ...(rounds ? { rounds } : {}),
  })
}

export interface TimelineEvent {
  type: 'created' | 'initial' | 'discuss' | 'system' | 'conclude' | 'concluded'
  timestamp: number
  agent_id: string | null
  agent_name: string | null
  round: number
  text: string
}

export interface DiscussionTimelinePayload {
  group_id: string
  status: string
  events: TimelineEvent[]
}

export const fetchDiscussionTimeline = async (
  workspaceId: string,
  groupId: string
): Promise<DiscussionTimelinePayload> => {
  const response = await apiFetch(
    `/api/team/discuss/timeline?workspace_id=${encodeURIComponent(workspaceId)}&group_id=${encodeURIComponent(groupId)}`
  )
  return (await response.json()) as DiscussionTimelinePayload
}
