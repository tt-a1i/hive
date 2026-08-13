import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createDiscussionOperations } from '../../src/server/discussion-operations.js'
import {
  injectDiscussionRecoveryIfNeeded,
  type DiscussionRecoveryInjectorDeps,
} from '../../src/server/discussion-recovery-injector.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('discussion crash recovery integration', () => {
  let db: Database.Database
  let ops: ReturnType<typeof createDiscussionOperations>
  let writeAgentStdin: ReturnType<typeof vi.fn>

  const buildDeps = (overrides: Partial<DiscussionRecoveryInjectorDeps> = {}): DiscussionRecoveryInjectorDeps => ({
    discussionOps: ops,
    writeAgentStdin,
    ...overrides,
  })

  beforeEach(() => {
    db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    ops = createDiscussionOperations(db)
    writeAgentStdin = vi.fn()
  })

  test('injects full recovery brief when worker crashes during thinking phase', () => {
    ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['worker-a', 'worker-b'],
      topic: 'API design',
      workspaceId: 'ws-1',
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-new', buildDeps())

    expect(writeAgentStdin).toHaveBeenCalledTimes(1)
    const injected = writeAgentStdin.mock.calls[0]![2] as string
    expect(injected).toContain('API design')
    expect(injected).toContain('初始观点收集')
    expect(injected).toContain('请提交你的初始观点')
  })

  test('does not inject when shouldInjectSync returns false (same run already synced)', () => {
    const { group } = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['worker-a', 'worker-b'],
      topic: 'already synced',
      workspaceId: 'ws-1',
    })

    ops.recordSyncAttempt(group.id, 'worker-a', 'thinking:0', 'run-1', 'full')

    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-1', buildDeps())

    expect(writeAgentStdin).not.toHaveBeenCalled()
  })

  test('injects terminal notice when discussion is concluded', () => {
    const { group } = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['worker-a', 'worker-b'],
      topic: 'concluded topic',
      workspaceId: 'ws-1',
    })

    ops.submitInitialPosition(group.id, 'worker-a', 'A pos')
    ops.submitInitialPosition(group.id, 'worker-b', 'B pos')
    ops.submitMessage(group.id, 'worker-a', 'A r1')
    ops.submitMessage(group.id, 'worker-b', 'B r1')
    ops.submitMessage(group.id, 'worker-a', 'A r2')
    ops.submitMessage(group.id, 'worker-b', 'B r2')
    ops.submitMessage(group.id, 'worker-a', 'A r3')
    ops.submitMessage(group.id, 'worker-b', 'B r3')
    ops.submitConclusion(group.id, 'worker-a', 'A final')
    ops.submitConclusion(group.id, 'worker-b', 'B final')

    const concludedGroup = ops.getGroup(group.id)
    const members = ops.getMembers(group.id)

    const deps = buildDeps({
      discussionOps: {
        ...ops,
        getActiveDiscussionsForAgent: () => [
          { group: concludedGroup, member: members[0]!, messages: [] },
        ],
        shouldInjectSync: () => true,
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-new', deps)

    expect(writeAgentStdin).toHaveBeenCalledTimes(1)
    const injected = writeAgentStdin.mock.calls[0]![2] as string
    expect(injected).toContain('结束')
    expect(injected).toContain('concluded topic')
  })

  test('same agent_run_id does not trigger duplicate injection (idempotency)', () => {
    ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['worker-a', 'worker-b'],
      topic: 'idempotent test',
      workspaceId: 'ws-1',
    })

    const deps = buildDeps()

    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-x', deps)
    expect(writeAgentStdin).toHaveBeenCalledTimes(1)

    writeAgentStdin.mockClear()
    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-x', deps)
    expect(writeAgentStdin).not.toHaveBeenCalled()
  })

  test('merges multiple active discussions into single stdin write', () => {
    const group1 = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['worker-a', 'worker-b'],
      topic: 'Discussion One',
      workspaceId: 'ws-1',
    })

    const group1Members = ops.getMembers(group1.group.id)
    const memberA1 = group1Members.find((m) => m.agent_id === 'worker-a')!

    const deps = buildDeps({
      discussionOps: {
        ...ops,
        getActiveDiscussionsForAgent: () => [
          { group: group1.group, member: memberA1, messages: [] },
          {
            group: { ...group1.group, id: 'fake-group-2', topic: 'Discussion Two' },
            member: { ...memberA1, group_id: 'fake-group-2' },
            messages: [],
          },
        ],
        shouldInjectSync: () => true,
      },
    })

    injectDiscussionRecoveryIfNeeded('ws-1', 'worker-a', 'run-multi', deps)

    expect(writeAgentStdin).toHaveBeenCalledTimes(1)
    const injected = writeAgentStdin.mock.calls[0]![2] as string
    expect(injected).toContain('Discussion One')
    expect(injected).toContain('Discussion Two')
  })
})
