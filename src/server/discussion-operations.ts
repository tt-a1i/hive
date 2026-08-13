import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import { BadRequestError, ConflictError } from './http-errors.js'

// --- Types ---

export interface DiscussionGroup {
  id: string
  workspace_id: string
  topic: string
  max_rounds: number
  current_round: number
  max_messages: number
  message_count: number
  status: DiscussionGroupStatus
  listen_mode: 'db' | 'stdin'
  orch_participates: number
  created_by: string
  created_at: number
  concluded_at: number | null
}

export type DiscussionGroupStatus =
  | 'thinking'
  | 'discussing'
  | 'concluding'
  | 'concluded'
  | 'cancelled'

export interface DiscussionMember {
  group_id: string
  agent_id: string
  agent_name: string
  role: 'worker' | 'orchestrator'
  member_status: DiscussionMemberStatus
  initial_position: string | null
  final_position: string | null
  rounds_participated: number
  last_message_at: number | null
}

export type DiscussionMemberStatus =
  | 'invited'
  | 'initial_submitted'
  | 'active'
  | 'round_submitted'
  | 'skipped'
  | 'final_submitted'
  | 'failed'

export interface DiscussionMessage {
  sequence: number
  group_id: string
  round: number
  from_agent_id: string
  message_type: 'initial' | 'discuss' | 'conclude' | 'system'
  text: string
  created_at: number
}

export interface StartDiscussionInput {
  createdBy: string
  listenMode?: 'db' | 'stdin'
  maxRounds?: number
  memberAgentIds: string[]
  orchParticipates?: boolean
  topic: string
  workspaceId: string
}

export interface StartDiscussionResult {
  group: DiscussionGroup
  members: DiscussionMember[]
}

export interface SubmitResult {
  group: DiscussionGroup
  members: DiscussionMember[]
  transitioned: boolean
  newStatus: DiscussionGroupStatus | null
}

export interface ActiveDiscussionForAgent {
  group: DiscussionGroup
  member: DiscussionMember
  messages: DiscussionMessage[]
}

// --- Operations Factory ---

export const createDiscussionOperations = (db: Database) => {
  const getGroup = (groupId: string): DiscussionGroup => {
    const row = db.prepare('SELECT * FROM discussion_groups WHERE id = ?').get(groupId) as
      | DiscussionGroup
      | undefined
    if (!row) throw new ConflictError(`Discussion group not found: ${groupId}`)
    return row
  }

  const getGroupForWorkspace = (groupId: string, workspaceId: string): DiscussionGroup => {
    const group = getGroup(groupId)
    if (group.workspace_id !== workspaceId) {
      throw new ConflictError(`Discussion group not found: ${groupId}`)
    }
    return group
  }

  const getMembers = (groupId: string): DiscussionMember[] =>
    db
      .prepare('SELECT * FROM discussion_members WHERE group_id = ?')
      .all(groupId) as DiscussionMember[]

  const getActiveMembers = (groupId: string): DiscussionMember[] =>
    db
      .prepare(
        `SELECT * FROM discussion_members WHERE group_id = ? AND member_status NOT IN ('skipped','failed')`
      )
      .all(groupId) as DiscussionMember[]

  const getMember = (groupId: string, agentId: string): DiscussionMember => {
    const row = db
      .prepare('SELECT * FROM discussion_members WHERE group_id = ? AND agent_id = ?')
      .get(groupId, agentId) as DiscussionMember | undefined
    if (!row) throw new ConflictError(`Agent ${agentId} is not a member of group ${groupId}`)
    return row
  }

  const getMessages = (groupId: string): DiscussionMessage[] =>
    db
      .prepare('SELECT * FROM discussion_messages WHERE group_id = ? ORDER BY sequence ASC')
      .all(groupId) as DiscussionMessage[]

  const getPhaseKey = (group: DiscussionGroup): string => {
    if (group.status === 'thinking') return 'thinking:0'
    if (group.status === 'discussing') return `discussing:${group.current_round}`
    if (group.status === 'concluding') return 'concluding:0'
    return 'terminal'
  }

  const getActiveGroupForAgent = (workspaceId: string, agentId: string): DiscussionGroup | null => {
    const row = db
      .prepare(
        `SELECT g.* FROM discussion_groups g
         JOIN discussion_members m ON g.id = m.group_id
         WHERE g.workspace_id = ? AND m.agent_id = ? AND g.status IN ('thinking','discussing','concluding')`
      )
      .get(workspaceId, agentId) as DiscussionGroup | undefined
    return row ?? null
  }

  const getActiveDiscussionsForAgent = (
    workspaceId: string,
    agentId: string
  ): ActiveDiscussionForAgent[] => {
    const rows = db
      .prepare(
        `SELECT
           g.id AS group_id,
           g.workspace_id,
           g.topic,
           g.max_rounds,
           g.current_round,
           g.max_messages,
           g.message_count,
           g.status,
           g.listen_mode,
           g.orch_participates,
           g.created_by,
           g.created_at,
           g.concluded_at,
           m.agent_id,
           m.agent_name,
           m.role,
           m.member_status,
           m.initial_position,
           m.final_position,
           m.rounds_participated,
           m.last_message_at
         FROM discussion_groups g
         JOIN discussion_members m ON g.id = m.group_id
         WHERE g.workspace_id = ?
           AND m.agent_id = ?
           AND g.status IN ('thinking','discussing','concluding')
           AND m.member_status NOT IN ('skipped','failed')
         ORDER BY g.created_at ASC`
      )
      .all(workspaceId, agentId) as Array<{
      agent_id: string
      agent_name: string
      concluded_at: number | null
      created_at: number
      created_by: string
      current_round: number
      final_position: string | null
      group_id: string
      initial_position: string | null
      last_message_at: number | null
      listen_mode: 'db' | 'stdin'
      max_messages: number
      max_rounds: number
      member_status: DiscussionMemberStatus
      message_count: number
      orch_participates: number
      role: 'worker' | 'orchestrator'
      rounds_participated: number
      status: DiscussionGroupStatus
      topic: string
      workspace_id: string
    }>

    return rows.map((row) => ({
      group: {
        id: row.group_id,
        workspace_id: row.workspace_id,
        topic: row.topic,
        max_rounds: row.max_rounds,
        current_round: row.current_round,
        max_messages: row.max_messages,
        message_count: row.message_count,
        status: row.status,
        listen_mode: row.listen_mode,
        orch_participates: row.orch_participates,
        created_by: row.created_by,
        created_at: row.created_at,
        concluded_at: row.concluded_at,
      },
      member: {
        group_id: row.group_id,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        role: row.role,
        member_status: row.member_status,
        initial_position: row.initial_position,
        final_position: row.final_position,
        rounds_participated: row.rounds_participated,
        last_message_at: row.last_message_at,
      },
      messages: getMessages(row.group_id),
    }))
  }

  const getActiveGroupsForWorkspace = (workspaceId: string): DiscussionGroup[] =>
    db
      .prepare(
        `SELECT * FROM discussion_groups WHERE workspace_id = ? AND status IN ('thinking','discussing','concluding')`
      )
      .all(workspaceId) as DiscussionGroup[]

  const updateGroupStatus = (
    groupId: string,
    status: DiscussionGroupStatus,
    extra?: Record<string, unknown>
  ) => {
    if (extra && Object.keys(extra).length > 0) {
      const sets = [`status = ?`, ...Object.keys(extra).map((k) => `${k} = ?`)]
      const values = [status, ...Object.values(extra), groupId]
      db.prepare(`UPDATE discussion_groups SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    } else {
      db.prepare('UPDATE discussion_groups SET status = ? WHERE id = ?').run(status, groupId)
    }
  }

  const updateMemberStatus = (
    groupId: string,
    agentId: string,
    memberStatus: DiscussionMemberStatus
  ) => {
    db.prepare(
      'UPDATE discussion_members SET member_status = ? WHERE group_id = ? AND agent_id = ?'
    ).run(memberStatus, groupId, agentId)
  }

  const incrementMessageCount = (groupId: string) => {
    db.prepare('UPDATE discussion_groups SET message_count = message_count + 1 WHERE id = ?').run(
      groupId
    )
  }

  const transitionToDiscussing = (groupId: string) => {
    db.prepare(
      `UPDATE discussion_groups SET status = 'discussing', current_round = 1 WHERE id = ?`
    ).run(groupId)
    db.prepare(
      `UPDATE discussion_members SET member_status = 'active' WHERE group_id = ? AND member_status = 'initial_submitted'`
    ).run(groupId)
  }

  const transitionToConcluding = (groupId: string) => {
    updateGroupStatus(groupId, 'concluding')
    db.prepare(
      `UPDATE discussion_members SET member_status = 'active' WHERE group_id = ? AND member_status = 'round_submitted'`
    ).run(groupId)
  }

  const advanceRound = (groupId: string, group: DiscussionGroup) => {
    const nextRound = group.current_round + 1
    if (nextRound > group.max_rounds) {
      transitionToConcluding(groupId)
      return 'concluding' as const
    }
    db.prepare('UPDATE discussion_groups SET current_round = ? WHERE id = ?').run(
      nextRound,
      groupId
    )
    db.prepare(
      `UPDATE discussion_members SET member_status = 'active' WHERE group_id = ? AND member_status = 'round_submitted'`
    ).run(groupId)
    return null
  }

  const allActiveMembersInStatus = (groupId: string, status: DiscussionMemberStatus): boolean => {
    const count = db
      .prepare(
        `SELECT COUNT(*) as c FROM discussion_members
         WHERE group_id = ? AND member_status NOT IN ('skipped','failed') AND member_status != ?`
      )
      .get(groupId, status) as { c: number }
    return count.c === 0
  }

  const shouldInjectSync = (groupId: string, agentId: string, agentRunId: string): boolean => {
    const group = getGroup(groupId)
    const phaseKey = getPhaseKey(group)
    const row = db
      .prepare(
        `SELECT id FROM discussion_sync_log
         WHERE group_id = ? AND member_id = ? AND phase_key = ? AND agent_run_id = ?
         LIMIT 1`
      )
      .get(groupId, agentId, phaseKey, agentRunId) as { id: number } | undefined
    return !row
  }

  const recordSyncAttempt = (
    groupId: string,
    agentId: string,
    phaseKey: string,
    agentRunId: string,
    syncKind: string
  ) => {
    db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT id FROM discussion_sync_log
           WHERE group_id = ? AND member_id = ? AND phase_key = ? AND agent_run_id = ? AND sync_kind = ?
           LIMIT 1`
        )
        .get(groupId, agentId, phaseKey, agentRunId, syncKind) as { id: number } | undefined
      if (existing) return

      db.prepare(
        `INSERT INTO discussion_sync_log (member_id, group_id, phase_key, agent_run_id, sync_kind, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(agentId, groupId, phaseKey, agentRunId, syncKind, Date.now())
    })()
  }

  // --- Public API (all mutations wrapped in transactions) ---

  const startDiscussion = (input: StartDiscussionInput): StartDiscussionResult => {
    const {
      createdBy,
      listenMode = 'db',
      maxRounds = 3,
      memberAgentIds,
      orchParticipates = false,
      topic,
      workspaceId,
    } = input

    if (memberAgentIds.length < 2)
      throw new BadRequestError('Discussion requires at least 2 members')
    if (memberAgentIds.length > 5) throw new BadRequestError('Discussion allows at most 5 members')
    if (maxRounds < 1 || maxRounds > 10)
      throw new BadRequestError('Rounds must be between 1 and 10')

    const groupId = randomUUID()
    const now = Date.now()

    const insertGroup = db.prepare(`
      INSERT INTO discussion_groups (id, workspace_id, topic, max_rounds, current_round, max_messages, message_count, status, listen_mode, orch_participates, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, 20, 0, 'thinking', ?, ?, ?, ?)
    `)

    const insertMember = db.prepare(`
      INSERT INTO discussion_members (group_id, agent_id, agent_name, member_status, role, rounds_participated)
      VALUES (?, ?, ?, 'invited', ?, 0)
    `)

    const checkActiveGroup = db.prepare(
      `SELECT g.id FROM discussion_groups g
       JOIN discussion_members m ON g.id = m.group_id
       WHERE g.workspace_id = ? AND m.agent_id = ? AND g.status IN ('thinking','discussing','concluding')
       LIMIT 1`
    )

    return db.transaction(() => {
      // F2: Re-check inside transaction for race safety
      for (const agentId of memberAgentIds) {
        const existing = checkActiveGroup.get(workspaceId, agentId) as { id: string } | undefined
        if (existing) {
          throw new ConflictError(
            `Agent ${agentId} is already in an active discussion group: ${existing.id}`
          )
        }
      }

      if (orchParticipates) {
        const existing = checkActiveGroup.get(workspaceId, createdBy) as { id: string } | undefined
        if (existing) {
          throw new ConflictError(
            `Orchestrator ${createdBy} is already in an active discussion group: ${existing.id}`
          )
        }
      }

      insertGroup.run(
        groupId,
        workspaceId,
        topic,
        maxRounds,
        listenMode,
        orchParticipates ? 1 : 0,
        createdBy,
        now
      )
      for (const agentId of memberAgentIds) {
        insertMember.run(groupId, agentId, agentId, 'worker')
      }

      if (orchParticipates) {
        insertMember.run(groupId, createdBy, createdBy, 'orchestrator')
      }

      return { group: getGroup(groupId), members: getMembers(groupId) }
    })()
  }

  const submitInitialPosition = (groupId: string, agentId: string, text: string): SubmitResult => {
    return db.transaction(() => {
      const group = getGroup(groupId)
      if (group.status !== 'thinking') {
        throw new ConflictError(
          `Group ${groupId} is not in thinking phase (current: ${group.status})`
        )
      }
      const member = getMember(groupId, agentId)
      if (member.member_status !== 'invited') {
        throw new ConflictError(`Member ${agentId} already submitted initial position`)
      }

      const now = Date.now()
      db.prepare(
        `UPDATE discussion_members SET member_status = 'initial_submitted', initial_position = ?, last_message_at = ? WHERE group_id = ? AND agent_id = ?`
      ).run(text, now, groupId, agentId)

      db.prepare(
        `INSERT INTO discussion_messages (group_id, round, from_agent_id, message_type, text, created_at) VALUES (?, 0, ?, 'initial', ?, ?)`
      ).run(groupId, agentId, text, now)

      incrementMessageCount(groupId)

      const allSubmitted = allActiveMembersInStatus(groupId, 'initial_submitted')
      let newStatus: DiscussionGroupStatus | null = null

      if (allSubmitted) {
        transitionToDiscussing(groupId)
        newStatus = 'discussing'
      }

      return {
        group: getGroup(groupId),
        members: getMembers(groupId),
        transitioned: !!newStatus,
        newStatus,
      }
    })()
  }

  const submitMessage = (groupId: string, agentId: string, text: string): SubmitResult => {
    return db.transaction(() => {
      const group = getGroup(groupId)
      if (group.status !== 'discussing') {
        throw new ConflictError(
          `Group ${groupId} is not in discussing phase (current: ${group.status})`
        )
      }
      const member = getMember(groupId, agentId)
      if (member.member_status === 'round_submitted') {
        throw new ConflictError(
          `Member ${agentId} already submitted for round ${group.current_round}`
        )
      }
      if (member.member_status === 'skipped' || member.member_status === 'failed') {
        throw new ConflictError(
          `Member ${agentId} cannot send messages (status: ${member.member_status})`
        )
      }

      const now = Date.now()
      db.prepare(
        `INSERT INTO discussion_messages (group_id, round, from_agent_id, message_type, text, created_at) VALUES (?, ?, ?, 'discuss', ?, ?)`
      ).run(groupId, group.current_round, agentId, text, now)

      db.prepare(
        `UPDATE discussion_members SET member_status = 'round_submitted', last_message_at = ?, rounds_participated = rounds_participated + 1 WHERE group_id = ? AND agent_id = ?`
      ).run(now, groupId, agentId)

      incrementMessageCount(groupId)

      const updatedGroup = getGroup(groupId)
      if (updatedGroup.message_count >= updatedGroup.max_messages) {
        transitionToConcluding(groupId)
        return {
          group: getGroup(groupId),
          members: getMembers(groupId),
          transitioned: true,
          newStatus: 'concluding' as DiscussionGroupStatus,
        }
      }

      const allRoundDone = allActiveMembersInStatus(groupId, 'round_submitted')
      let newStatus: DiscussionGroupStatus | null = null

      if (allRoundDone) {
        newStatus = advanceRound(groupId, updatedGroup)
      }

      return {
        group: getGroup(groupId),
        members: getMembers(groupId),
        transitioned: !!newStatus,
        newStatus,
      }
    })()
  }

  const submitConclusion = (groupId: string, agentId: string, text: string): SubmitResult => {
    return db.transaction(() => {
      const group = getGroup(groupId)
      if (group.status !== 'concluding') {
        throw new ConflictError(
          `Group ${groupId} is not in concluding phase (current: ${group.status})`
        )
      }
      const member = getMember(groupId, agentId)
      if (member.member_status === 'final_submitted') {
        throw new ConflictError(`Member ${agentId} already submitted final position`)
      }
      if (member.member_status === 'skipped' || member.member_status === 'failed') {
        throw new ConflictError(
          `Member ${agentId} cannot conclude (status: ${member.member_status})`
        )
      }

      const now = Date.now()
      db.prepare(
        `UPDATE discussion_members SET member_status = 'final_submitted', final_position = ?, last_message_at = ? WHERE group_id = ? AND agent_id = ?`
      ).run(text, now, groupId, agentId)

      db.prepare(
        `INSERT INTO discussion_messages (group_id, round, from_agent_id, message_type, text, created_at) VALUES (?, ?, ?, 'conclude', ?, ?)`
      ).run(groupId, group.current_round, agentId, text, now)

      incrementMessageCount(groupId)

      const allConcluded = allActiveMembersInStatus(groupId, 'final_submitted')
      let newStatus: DiscussionGroupStatus | null = null

      if (allConcluded) {
        db.prepare(
          `UPDATE discussion_groups SET status = 'concluded', concluded_at = ? WHERE id = ?`
        ).run(now, groupId)
        newStatus = 'concluded'
      }

      return {
        group: getGroup(groupId),
        members: getMembers(groupId),
        transitioned: !!newStatus,
        newStatus,
      }
    })()
  }

  const endDiscussion = (groupId: string, _reason?: string): DiscussionGroup => {
    return db.transaction(() => {
      const group = getGroup(groupId)
      if (group.status === 'concluded' || group.status === 'cancelled') {
        throw new ConflictError(`Group ${groupId} is already ${group.status}`)
      }
      updateGroupStatus(groupId, 'cancelled', { concluded_at: Date.now() })
      return getGroup(groupId)
    })()
  }

  const skipMember = (groupId: string, agentId: string): SubmitResult => {
    return db.transaction(() => {
      const group = getGroup(groupId)
      if (group.status === 'concluded' || group.status === 'cancelled') {
        throw new ConflictError(`Group ${groupId} is already ${group.status}`)
      }
      const member = getMember(groupId, agentId)
      if (member.member_status === 'skipped' || member.member_status === 'failed') {
        throw new ConflictError(`Member ${agentId} is already ${member.member_status}`)
      }

      updateMemberStatus(groupId, agentId, 'skipped')

      const activeMembers = getActiveMembers(groupId)
      if (activeMembers.length < 2) {
        updateGroupStatus(groupId, 'cancelled', { concluded_at: Date.now() })
        return {
          group: getGroup(groupId),
          members: getMembers(groupId),
          transitioned: true,
          newStatus: 'cancelled' as DiscussionGroupStatus,
        }
      }

      let newStatus: DiscussionGroupStatus | null = null

      if (group.status === 'thinking') {
        if (allActiveMembersInStatus(groupId, 'initial_submitted')) {
          transitionToDiscussing(groupId)
          newStatus = 'discussing'
        }
      } else if (group.status === 'discussing') {
        if (allActiveMembersInStatus(groupId, 'round_submitted')) {
          newStatus = advanceRound(groupId, group)
        }
      } else if (group.status === 'concluding') {
        if (allActiveMembersInStatus(groupId, 'final_submitted')) {
          db.prepare(
            `UPDATE discussion_groups SET status = 'concluded', concluded_at = ? WHERE id = ?`
          ).run(Date.now(), groupId)
          newStatus = 'concluded'
        }
      }

      return {
        group: getGroup(groupId),
        members: getMembers(groupId),
        transitioned: !!newStatus,
        newStatus,
      }
    })()
  }

  const markMemberFailed = (groupId: string, agentId: string): SubmitResult => {
    return db.transaction(() => {
      updateMemberStatus(groupId, agentId, 'failed')

      const group = getGroup(groupId)
      if (group.status === 'concluded' || group.status === 'cancelled') {
        return { group, members: getMembers(groupId), transitioned: false, newStatus: null }
      }

      const activeMembers = getActiveMembers(groupId)
      if (activeMembers.length < 2) {
        updateGroupStatus(groupId, 'cancelled', { concluded_at: Date.now() })
        return {
          group: getGroup(groupId),
          members: getMembers(groupId),
          transitioned: true,
          newStatus: 'cancelled' as DiscussionGroupStatus,
        }
      }

      let newStatus: DiscussionGroupStatus | null = null

      if (group.status === 'thinking') {
        if (allActiveMembersInStatus(groupId, 'initial_submitted')) {
          transitionToDiscussing(groupId)
          newStatus = 'discussing'
        }
      } else if (group.status === 'discussing') {
        if (allActiveMembersInStatus(groupId, 'round_submitted')) {
          newStatus = advanceRound(groupId, group)
        }
      } else if (group.status === 'concluding') {
        if (allActiveMembersInStatus(groupId, 'final_submitted')) {
          db.prepare(
            `UPDATE discussion_groups SET status = 'concluded', concluded_at = ? WHERE id = ?`
          ).run(Date.now(), groupId)
          newStatus = 'concluded'
        }
      }

      return {
        group: getGroup(groupId),
        members: getMembers(groupId),
        transitioned: !!newStatus,
        newStatus,
      }
    })()
  }

  const setMemberName = (groupId: string, agentId: string, name: string) => {
    db.prepare(
      'UPDATE discussion_members SET agent_name = ? WHERE group_id = ? AND agent_id = ?'
    ).run(name, groupId, agentId)
  }

  const steerDiscussion = (groupId: string, text: string): DiscussionGroup => {
    const group = getGroup(groupId)
    if (group.status !== 'discussing') {
      throw new ConflictError(
        `Cannot steer: group is not in discussing phase (current: ${group.status})`
      )
    }
    const now = Date.now()
    db.prepare(
      `INSERT INTO discussion_messages (group_id, round, from_agent_id, message_type, text, created_at) VALUES (?, ?, '__system__', 'system', ?, ?)`
    ).run(groupId, group.current_round, text, now)
    return group
  }

  const extendRounds = (groupId: string, additionalRounds: number): DiscussionGroup => {
    const group = getGroup(groupId)
    if (group.status !== 'discussing') {
      throw new ConflictError(
        `Cannot extend: group is not in discussing phase (current: ${group.status})`
      )
    }
    if (additionalRounds < 1) {
      throw new BadRequestError('additionalRounds must be >= 1')
    }
    db.prepare('UPDATE discussion_groups SET max_rounds = max_rounds + ? WHERE id = ?').run(
      additionalRounds,
      groupId
    )
    return getGroup(groupId)
  }

  return {
    endDiscussion,
    extendRounds,
    getActiveDiscussionsForAgent,
    getActiveGroupForAgent,
    getActiveGroupsForWorkspace,
    getGroup,
    getGroupForWorkspace,
    getMembers,
    getMessages,
    getPhaseKey,
    markMemberFailed,
    recordSyncAttempt,
    setMemberName,
    shouldInjectSync,
    skipMember,
    startDiscussion,
    steerDiscussion,
    submitConclusion,
    submitInitialPosition,
    submitMessage,
  }
}

export type DiscussionOperations = ReturnType<typeof createDiscussionOperations>
