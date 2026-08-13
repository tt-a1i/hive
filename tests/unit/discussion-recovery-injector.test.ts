import { describe, expect, it, vi } from 'vitest'

import type { DiscussionGroup, DiscussionMember, DiscussionMessage } from '../../src/server/discussion-operations.js'
import {
  createDiscussionRecoveryInjector,
  injectDiscussionRecoveryIfNeeded,
  type DiscussionRecoveryInjectorDeps,
} from '../../src/server/discussion-recovery-injector.js'

const makeGroup = (overrides: Partial<DiscussionGroup> = {}): DiscussionGroup => ({
  id: 'group-1',
  workspace_id: 'ws-1',
  topic: 'API 设计方案',
  max_rounds: 3,
  current_round: 1,
  max_messages: 30,
  message_count: 2,
  status: 'discussing',
  listen_mode: 'stdin',
  orch_participates: 0,
  created_by: 'orch-1',
  created_at: Date.now(),
  concluded_at: null,
  ...overrides,
})

const makeMember = (overrides: Partial<DiscussionMember> = {}): DiscussionMember => ({
  group_id: 'group-1',
  agent_id: 'agent-1',
  agent_name: '毕昇',
  role: 'worker',
  member_status: 'active',
  initial_position: null,
  final_position: null,
  rounds_participated: 0,
  last_message_at: null,
  ...overrides,
})

const makeMessage = (overrides: Partial<DiscussionMessage> = {}): DiscussionMessage => ({
  sequence: 1,
  group_id: 'group-1',
  round: 1,
  from_agent_id: 'agent-1',
  message_type: 'discuss',
  text: '我认为应该用 REST',
  created_at: Date.now(),
  ...overrides,
})

const makeDeps = (overrides: Partial<DiscussionRecoveryInjectorDeps> = {}): DiscussionRecoveryInjectorDeps => ({
  discussionOps: {
    getActiveDiscussionsForAgent: vi.fn().mockReturnValue([]),
    getPhaseKey: vi.fn().mockReturnValue('discussing:1'),
    shouldInjectSync: vi.fn().mockReturnValue(true),
    recordSyncAttempt: vi.fn(),
    getMembers: vi.fn().mockReturnValue([makeMember()]),
  },
  writeAgentStdin: vi.fn(),
  ...overrides,
})

describe('discussion-recovery-injector', () => {
  it('does nothing when no active discussions', () => {
    const deps = makeDeps()
    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    expect(deps.writeAgentStdin).not.toHaveBeenCalled()
    expect(deps.discussionOps.recordSyncAttempt).not.toHaveBeenCalled()
  })

  it('injects full recovery brief for active member', () => {
    const group = makeGroup({ status: 'discussing' })
    const member = makeMember({ member_status: 'active' })
    const messages = [makeMessage()]
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([{ group, member, messages }]),
        getPhaseKey: vi.fn().mockReturnValue('discussing:1'),
        shouldInjectSync: vi.fn().mockReturnValue(true),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockReturnValue([member]),
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    expect(deps.writeAgentStdin).toHaveBeenCalledOnce()
    const text = (deps.writeAgentStdin as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(text).toContain('讨论恢复上下文')
    expect(text).toContain('API 设计方案')
    expect(text).toContain('team discuss --submit')
    expect(deps.discussionOps.recordSyncAttempt).toHaveBeenCalledWith(
      'group-1', 'agent-1', 'discussing:1', 'run-1', 'full'
    )
  })

  it('injects minimal brief for round_submitted member', () => {
    const group = makeGroup({ status: 'discussing', current_round: 2 })
    const member = makeMember({ member_status: 'round_submitted' })
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([{ group, member, messages: [] }]),
        getPhaseKey: vi.fn().mockReturnValue('discussing:2'),
        shouldInjectSync: vi.fn().mockReturnValue(true),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockReturnValue([member]),
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    const text = (deps.writeAgentStdin as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(text).toContain('讨论状态变更')
    expect(deps.discussionOps.recordSyncAttempt).toHaveBeenCalledWith(
      'group-1', 'agent-1', 'discussing:2', 'run-1', 'minimal'
    )
  })

  it('injects terminal notice for concluded discussion', () => {
    const group = makeGroup({ status: 'concluded' })
    const member = makeMember({ member_status: 'active' })
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([{ group, member, messages: [] }]),
        getPhaseKey: vi.fn().mockReturnValue('terminal'),
        shouldInjectSync: vi.fn().mockReturnValue(true),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockReturnValue([member]),
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    const text = (deps.writeAgentStdin as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(text).toContain('讨论已结束')
    expect(deps.discussionOps.recordSyncAttempt).toHaveBeenCalledWith(
      'group-1', 'agent-1', 'terminal', 'run-1', 'terminal'
    )
  })

  it('skips injection when shouldInjectSync returns false', () => {
    const group = makeGroup()
    const member = makeMember()
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([{ group, member, messages: [] }]),
        getPhaseKey: vi.fn().mockReturnValue('discussing:1'),
        shouldInjectSync: vi.fn().mockReturnValue(false),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockReturnValue([member]),
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    expect(deps.writeAgentStdin).not.toHaveBeenCalled()
    expect(deps.discussionOps.recordSyncAttempt).not.toHaveBeenCalled()
  })

  it('merges multiple discussions into single stdin write', () => {
    const group1 = makeGroup({ id: 'group-1', topic: '设计方案 A' })
    const group2 = makeGroup({ id: 'group-2', topic: '设计方案 B', status: 'thinking' })
    const member1 = makeMember({ group_id: 'group-1', member_status: 'active' })
    const member2 = makeMember({ group_id: 'group-2', member_status: 'invited' })
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([
          { group: group1, member: member1, messages: [] },
          { group: group2, member: member2, messages: [] },
        ]),
        getPhaseKey: vi.fn().mockImplementation((g: DiscussionGroup) =>
          g.status === 'thinking' ? 'thinking:0' : 'discussing:1'
        ),
        shouldInjectSync: vi.fn().mockReturnValue(true),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockImplementation((groupId: string) =>
          groupId === 'group-1' ? [member1] : [member2]
        ),
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'agent-1', 'run-1', deps)

    expect(deps.writeAgentStdin).toHaveBeenCalledOnce()
    const text = (deps.writeAgentStdin as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(text).toContain('设计方案 A')
    expect(text).toContain('设计方案 B')
    expect(deps.discussionOps.recordSyncAttempt).toHaveBeenCalledTimes(2)
  })

  it('factory createDiscussionRecoveryInjector works', () => {
    const group = makeGroup()
    const member = makeMember({ member_status: 'active' })
    const deps = makeDeps({
      discussionOps: {
        getActiveDiscussionsForAgent: vi.fn().mockReturnValue([{ group, member, messages: [] }]),
        getPhaseKey: vi.fn().mockReturnValue('discussing:1'),
        shouldInjectSync: vi.fn().mockReturnValue(true),
        recordSyncAttempt: vi.fn(),
        getMembers: vi.fn().mockReturnValue([member]),
      },
    })

    const injector = createDiscussionRecoveryInjector(deps)
    injector.inject('ws-1', 'agent-1', 'run-1')

    expect(deps.writeAgentStdin).toHaveBeenCalledOnce()
  })
})
