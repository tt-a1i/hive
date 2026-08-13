import type {
  ActiveDiscussionForAgent,
  DiscussionGroup,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOperations,
} from './discussion-operations.js'
import {
  buildFullRecoveryBrief,
  buildMinimalDeltaBrief,
  buildTerminalNotice,
  type FullRecoveryBriefInput,
  type MinimalDeltaBriefInput,
  type TerminalNoticeInput,
} from './discussion-recovery-templates.js'

export type SyncKind = 'full' | 'minimal' | 'terminal'

export interface DiscussionRecoveryInjectorDeps {
  discussionOps: Pick<
    DiscussionOperations,
    'getActiveDiscussionsForAgent' | 'getPhaseKey' | 'shouldInjectSync' | 'recordSyncAttempt' | 'getMembers'
  >
  writeAgentStdin: (workspaceId: string, agentId: string, text: string) => void
}

const determineSyncKind = (group: DiscussionGroup, member: DiscussionMember): SyncKind => {
  if (group.status === 'concluded' || group.status === 'cancelled') return 'terminal'
  if (member.member_status === 'invited' || member.member_status === 'active') return 'full'
  return 'minimal'
}

const determineNextAction = (group: DiscussionGroup, member: DiscussionMember): string => {
  if (group.status === 'thinking') {
    if (member.member_status === 'invited') return '请提交你的初始观点（team discuss --submit）'
    return '等待其他成员提交初始观点'
  }
  if (group.status === 'discussing') {
    if (member.member_status === 'active') return '请提交本轮讨论回复（team discuss --submit）'
    return '等待其他成员完成本轮讨论'
  }
  if (group.status === 'concluding') {
    if (member.role === 'orchestrator') return '请提交讨论结论（team discuss --conclude）'
    return '等待 Orchestrator 提交结论'
  }
  return '讨论已结束，无需操作'
}

const formatPhase = (group: DiscussionGroup): string => {
  if (group.status === 'thinking') return '初始观点收集'
  if (group.status === 'discussing') return '讨论中'
  if (group.status === 'concluding') return '结论阶段'
  return group.status
}

const buildBriefForKind = (
  kind: SyncKind,
  group: DiscussionGroup,
  member: DiscussionMember,
  messages: DiscussionMessage[],
  allMembers: DiscussionMember[]
): string => {
  if (kind === 'terminal') {
    const input: TerminalNoticeInput = {
      topic: group.topic,
      finalStatus: group.status === 'concluded' ? 'concluded' : 'cancelled',
    }
    return buildTerminalNotice(input)
  }

  if (kind === 'minimal') {
    const input: MinimalDeltaBriefInput = {
      topic: group.topic,
      phase: formatPhase(group),
      currentRound: group.current_round,
      nextAction: determineNextAction(group, member),
    }
    return buildMinimalDeltaBrief(input)
  }

  const ownSubmissions = messages
    .filter((m) => m.from_agent_id === member.agent_id)
    .slice(-3)
    .map((m) => m.text.slice(0, 200))

  const visibleMessages = messages
    .slice(-5)
    .map((m) => {
      const name = allMembers.find((mem) => mem.agent_id === m.from_agent_id)?.agent_name ?? m.from_agent_id
      return { name, text: m.text.slice(0, 200) }
    })

  const input: FullRecoveryBriefInput = {
    topic: group.topic,
    phase: formatPhase(group),
    currentRound: group.current_round,
    maxRounds: group.max_rounds,
    ownSubmissions,
    visibleMessages,
    nextAction: determineNextAction(group, member),
  }
  return buildFullRecoveryBrief(input)
}

export const injectDiscussionRecoveryIfNeeded = (
  workspaceId: string,
  agentId: string,
  agentRunId: string,
  deps: DiscussionRecoveryInjectorDeps
): void => {
  const { discussionOps, writeAgentStdin } = deps
  const discussions = discussionOps.getActiveDiscussionsForAgent(workspaceId, agentId)
  if (discussions.length === 0) return

  const sections: string[] = []

  for (const { group, member, messages } of discussions) {
    if (!discussionOps.shouldInjectSync(group.id, agentId, agentRunId)) continue

    const syncKind = determineSyncKind(group, member)
    const allMembers = discussionOps.getMembers(group.id)
    const phaseKey = discussionOps.getPhaseKey(group)

    sections.push(buildBriefForKind(syncKind, group, member, messages, allMembers))
    discussionOps.recordSyncAttempt(group.id, agentId, phaseKey, agentRunId, syncKind)
  }

  if (sections.length === 0) return
  writeAgentStdin(workspaceId, agentId, sections.join('\n\n'))
}

export const createDiscussionRecoveryInjector = (deps: DiscussionRecoveryInjectorDeps) => ({
  inject: (workspaceId: string, agentId: string, agentRunId: string) =>
    injectDiscussionRecoveryIfNeeded(workspaceId, agentId, agentRunId, deps),
})
