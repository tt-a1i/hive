import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'

import { createDiscussionOperations } from '../../src/server/discussion-operations.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('discussion sync recovery operations', () => {
  let db: Database.Database
  let ops: ReturnType<typeof createDiscussionOperations>

  beforeEach(() => {
    db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    ops = createDiscussionOperations(db)
  })

  test('lists active discussions for an agent with its member row and messages', () => {
    const result = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['agent-a', 'agent-b'],
      topic: 'recover discussion',
      workspaceId: 'ws-1',
    })

    ops.submitInitialPosition(result.group.id, 'agent-a', 'Initial A')

    const active = ops.getActiveDiscussionsForAgent('ws-1', 'agent-a')

    expect(active).toHaveLength(1)
    expect(active[0]!.group.id).toBe(result.group.id)
    expect(active[0]!.member.agent_id).toBe('agent-a')
    expect(active[0]!.messages.map((message) => message.text)).toEqual(['Initial A'])
  })

  test('excludes skipped, failed, and inactive discussion memberships', () => {
    const skipped = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['agent-a', 'agent-b'],
      topic: 'skip me',
      workspaceId: 'ws-1',
    })
    ops.skipMember(skipped.group.id, 'agent-a')

    const concluded = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['agent-c', 'agent-d'],
      topic: 'finish me',
      workspaceId: 'ws-1',
    })
    ops.submitInitialPosition(concluded.group.id, 'agent-c', 'C initial')
    ops.submitInitialPosition(concluded.group.id, 'agent-d', 'D initial')
    ops.submitMessage(concluded.group.id, 'agent-c', 'C round')
    ops.submitMessage(concluded.group.id, 'agent-d', 'D round')
    ops.submitMessage(concluded.group.id, 'agent-c', 'C round 2')
    ops.submitMessage(concluded.group.id, 'agent-d', 'D round 2')
    ops.submitMessage(concluded.group.id, 'agent-c', 'C round 3')
    ops.submitMessage(concluded.group.id, 'agent-d', 'D round 3')
    ops.submitConclusion(concluded.group.id, 'agent-c', 'C final')
    ops.submitConclusion(concluded.group.id, 'agent-d', 'D final')

    expect(ops.getActiveDiscussionsForAgent('ws-1', 'agent-a')).toEqual([])
    expect(ops.getActiveDiscussionsForAgent('ws-1', 'agent-c')).toEqual([])
  })

  test('computes phase keys for active and terminal phases', () => {
    const result = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['agent-a', 'agent-b'],
      topic: 'phase keys',
      workspaceId: 'ws-1',
    })

    expect(ops.getPhaseKey(result.group)).toBe('thinking:0')

    const discussing = ops.submitInitialPosition(result.group.id, 'agent-a', 'A')
    expect(ops.getPhaseKey(discussing.group)).toBe('thinking:0')

    const transitioned = ops.submitInitialPosition(result.group.id, 'agent-b', 'B')
    expect(ops.getPhaseKey(transitioned.group)).toBe('discussing:1')

    ops.endDiscussion(result.group.id)
    expect(ops.getPhaseKey(ops.getGroup(result.group.id))).toBe('terminal')
  })

  test('injects sync only when the current run has no record for the current phase', () => {
    const result = ops.startDiscussion({
      createdBy: 'ws-1:orchestrator',
      memberAgentIds: ['agent-a', 'agent-b'],
      topic: 'sync me',
      workspaceId: 'ws-1',
    })

    expect(ops.shouldInjectSync(result.group.id, 'agent-a', 'run-1')).toBe(true)

    ops.recordSyncAttempt(result.group.id, 'agent-a', 'thinking:0', 'run-1', 'full_recovery')
    ops.recordSyncAttempt(result.group.id, 'agent-a', 'thinking:0', 'run-1', 'full_recovery')

    expect(ops.shouldInjectSync(result.group.id, 'agent-a', 'run-1')).toBe(false)
    expect(ops.shouldInjectSync(result.group.id, 'agent-a', 'run-2')).toBe(true)

    const rows = db
      .prepare('SELECT * FROM discussion_sync_log WHERE group_id = ? AND member_id = ?')
      .all(result.group.id, 'agent-a')
    expect(rows).toHaveLength(1)
  })
})
