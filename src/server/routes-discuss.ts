import {
  type BroadcastResult,
  broadcastToMembers,
  clearWriteQueue,
  formatCancelNotice,
  formatConcludeInvite,
  formatDiscussionInvite,
  formatDiscussMessage,
  formatInitialBundle,
  formatSynthesisReport,
  injectToAgent,
} from './discussion-message-router.js'
import { appendActionsToTasks, parseNextActions, type TaskService } from './discussion-post-actions.js'
import { getDiscussionTemplate } from './discussion-templates.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { resolveCommandPresetId } from './team-list-enrichment.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

interface DiscussStartBody {
  project_id: string
  from_agent_id?: string
  token?: string
  members: string[]
  topic: string
  rounds?: number
  listen_mode?: 'db' | 'stdin'
  template_id?: string
  orch_participates?: boolean
}

interface DiscussMessageBody {
  project_id: string
  from_agent_id: string
  token?: string
  text: string
}

interface DiscussConcludeBody {
  project_id: string
  from_agent_id: string
  token?: string
  text: string
}

interface DiscussEndBody {
  project_id: string
  from_agent_id?: string
  token?: string
  reason?: string
  group_id?: string
}

interface DiscussSkipBody {
  project_id: string
  from_agent_id?: string
  token?: string
  worker_name: string
  group_id?: string
}

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const writeToAgentStdin = (
  store: { writeAgentStdin: (workspaceId: string, agentId: string, text: string) => void },
  workspaceId: string,
  agentId: string,
  text: string
) => {
  store.writeAgentStdin(workspaceId, agentId, text)
}

const handleBroadcastFailures = (
  store: {
    discussionOps: { markMemberFailed: (groupId: string, agentId: string) => unknown }
    markDiscussionLeft: (workspaceId: string, agentId: string) => void
  },
  workspaceId: string,
  groupId: string,
  result: BroadcastResult
) => {
  for (const agentId of result.failed) {
    try {
      const failureResult = store.discussionOps.markMemberFailed(groupId, agentId)
      store.markDiscussionLeft(workspaceId, agentId)
      if (
        typeof failureResult === 'object' &&
        failureResult !== null &&
        'newStatus' in failureResult &&
        (failureResult.newStatus === 'cancelled' || failureResult.newStatus === 'concluded') &&
        'members' in failureResult &&
        Array.isArray(failureResult.members)
      ) {
        markMembersOutOfDiscussion(store, workspaceId, failureResult.members)
      }
    } catch {
      // already failed/skipped
    }
  }
}

const clearAllMemberQueues = (workspaceId: string, members: Array<{ agent_id: string }>) => {
  for (const m of members) {
    clearWriteQueue(workspaceId, m.agent_id)
  }
}

const markMembersInDiscussion = (
  store: { markDiscussionJoined: (workspaceId: string, agentId: string) => void },
  workspaceId: string,
  members: Array<{ agent_id: string; member_status?: string }>
) => {
  for (const member of members) {
    if (member.member_status !== 'skipped' && member.member_status !== 'failed') {
      store.markDiscussionJoined(workspaceId, member.agent_id)
    }
  }
}

const markMembersOutOfDiscussion = (
  store: { markDiscussionLeft: (workspaceId: string, agentId: string) => void },
  workspaceId: string,
  members: Array<{ agent_id: string }>
) => {
  for (const member of members) {
    store.markDiscussionLeft(workspaceId, member.agent_id)
  }
}

type ConcludedStore = {
  getWorkspaceSnapshot: (workspaceId: string) => { summary: { path: string } }
  taskService?: TaskService
}

const handleConcludedPostActions = (
  store: ConcludedStore,
  workspaceId: string,
  topic: string,
  reportText: string,
  orchId: string,
  writeFn: (ws: string, agentId: string, text: string) => void,
  groupId?: string
) => {
  const actions = parseNextActions(reportText)
  if (actions.length === 0) return

  try {
    const workspace = store.getWorkspaceSnapshot(workspaceId)
    const count = appendActionsToTasks(
      workspace.summary.path,
      topic,
      actions,
      store.taskService,
      workspaceId,
      groupId
    )
    if (count > 0) {
      const notice = store.taskService
        ? `[Hive 系统消息：讨论「${topic}」已结束，${count} 条建议行动已写入 tasks.md 作为待认领提议（status: proposed）。请用 team task list --status proposed 查看，认领后用 team task done/send 派发]`
        : `[Hive 系统消息：讨论「${topic}」已结束，${count} 条建议行动已写入 tasks.md]`
      injectToAgent(workspaceId, orchId, notice, writeFn)
    }
  } catch (err) {
    console.error('[hive:discussion] post-action failed:', err)
  }
}

export const discussRoutes: RouteDefinition[] = [
  route('POST', '/api/team/discuss/start', async ({ request, response, store }) => {
    const body = await readJsonBody<DiscussStartBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const topic = requireNonEmptyString(body.topic, 'topic')
    const memberNames = body.members

    if (!Array.isArray(memberNames) || memberNames.length < 2) {
      throw new BadRequestError('At least 2 members required')
    }

    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'discuss')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can start discussions')
      }
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const workers = store.listWorkers(projectId)
    const memberAgentIds: string[] = []
    for (const name of memberNames) {
      const worker = workers.find((w) => w.name === name)
      if (!worker) throw new BadRequestError(`Worker not found: ${name}`)
      if (worker.pendingTaskCount > 0) {
        throw new ConflictError(`Worker ${name} has pending tasks, cannot join discussion`)
      }
      if (!store.getActiveRunByAgentId(projectId, worker.id)) {
        throw new ConflictError(`Worker ${name} has no active PTY run`)
      }
      memberAgentIds.push(worker.id)
    }

    const createdBy = body.from_agent_id ?? `${projectId}:orchestrator`
    const template = body.template_id ? getDiscussionTemplate(body.template_id) : undefined
    if (body.template_id && !template) {
      throw new BadRequestError(`Unknown template_id: ${body.template_id}`)
    }
    const maxRounds = body.rounds ?? template?.defaultRounds ?? 3
    const result = store.discussionOps.startDiscussion({
      createdBy,
      listenMode: body.listen_mode ?? 'db',
      maxRounds,
      memberAgentIds,
      orchParticipates: body.orch_participates ?? false,
      topic,
      workspaceId: projectId,
    })
    markMembersInDiscussion(store, projectId, result.members)

    for (const m of result.members) {
      const worker = workers.find((w) => w.id === m.agent_id)
      if (worker && worker.name !== m.agent_name) {
        store.discussionOps.setMemberName(result.group.id, m.agent_id, worker.name)
      }
    }

    // Set Orch member name if participating
    if (body.orch_participates) {
      store.discussionOps.setMemberName(result.group.id, createdBy, 'Orchestrator')
    }

    const memberNamesList = result.members.map((m) => {
      const w = workers.find((w2) => w2.id === m.agent_id)
      return w?.name ?? m.agent_id
    })
    const roleHint = template
      ? `\n角色分配：${template.roles
          .slice(0, memberNamesList.length)
          .map((r, i) => `${memberNamesList[i]} → ${r}`)
          .join(', ')}`
      : ''
    const inviteText =
      formatDiscussionInvite(topic, memberNamesList, result.group.max_rounds) + roleHint

    const writeFn = (ws: string, agentId: string, text: string) =>
      writeToAgentStdin(store, ws, agentId, text)

    // Don't send invite to Orch member — they initiated the discussion
    const inviteMembers = result.members.filter((m) => m.role !== 'orchestrator')
    const broadcast = await broadcastToMembers(projectId, inviteMembers, '', inviteText, writeFn)
    handleBroadcastFailures(store, projectId, result.group.id, broadcast)

    sendJson(response, 201, {
      ok: true,
      group_id: result.group.id,
      delivery_status: { delivered: broadcast.delivered.length, failed: broadcast.failed.length },
    })
  }),

  route('POST', '/api/team/discuss/message', async ({ request, response, store }) => {
    const body = await readJsonBody<DiscussMessageBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const text = requireNonEmptyString(body.text, 'text')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'discuss')

    const group = store.discussionOps.getActiveGroupForAgent(projectId, fromAgentId)
    if (!group) {
      throw new ConflictError('Agent is not in any active discussion group')
    }
    store.discussionOps.getGroupForWorkspace(group.id, projectId)

    const writeFn = (ws: string, agentId: string, t: string) =>
      writeToAgentStdin(store, ws, agentId, t)

    if (group.status === 'thinking') {
      const result = store.discussionOps.submitInitialPosition(group.id, fromAgentId, text)

      if (result.transitioned && result.newStatus === 'discussing') {
        const members = result.members
        const positions = members
          .filter((m) => m.initial_position !== null)
          .map((m) => ({ name: m.agent_name, text: m.initial_position! }))
        const bundleText = formatInitialBundle(positions, 1, result.group.max_rounds)
        const broadcast = await broadcastToMembers(projectId, members, '', bundleText, writeFn)
        handleBroadcastFailures(store, projectId, group.id, broadcast)

        if (result.group.listen_mode === 'stdin' && !result.group.orch_participates) {
          const orchId = `${projectId}:orchestrator`
          injectToAgent(projectId, orchId, bundleText, writeFn)
        }
      }

      sendJson(response, 202, { ok: true, group_id: group.id, phase: result.group.status })
      return
    }

    if (group.status === 'concluding') {
      const result = store.discussionOps.submitConclusion(group.id, fromAgentId, text)

      if (result.transitioned && result.newStatus === 'concluded') {
        const messages = store.discussionOps.getMessages(group.id)
        const reportText = formatSynthesisReport(result.group, result.members, messages)
        const orchId = `${projectId}:orchestrator`
        injectToAgent(projectId, orchId, reportText, writeFn)
        handleConcludedPostActions(
          store,
          projectId,
          result.group.topic,
          reportText,
          orchId,
          writeFn,
          group.id
        )
        clearAllMemberQueues(projectId, result.members)
        markMembersOutOfDiscussion(store, projectId, result.members)
      }

      sendJson(response, 202, { ok: true, group_id: group.id, phase: result.group.status })
      return
    }

    const result = store.discussionOps.submitMessage(group.id, fromAgentId, text)

    const senderMember = result.members.find((m) => m.agent_id === fromAgentId)
    const senderName = senderMember?.agent_name ?? fromAgentId
    const msgText = formatDiscussMessage(senderName, group.current_round, group.max_rounds, text)
    const broadcast = await broadcastToMembers(
      projectId,
      result.members,
      fromAgentId,
      msgText,
      writeFn
    )
    handleBroadcastFailures(store, projectId, group.id, broadcast)

    if (group.listen_mode === 'stdin' && !group.orch_participates) {
      const orchId = `${projectId}:orchestrator`
      injectToAgent(projectId, orchId, msgText, writeFn)
    }

    if (result.transitioned && result.newStatus === 'concluding') {
      const concludeText = formatConcludeInvite()
      await broadcastToMembers(projectId, result.members, '', concludeText, writeFn)
    }

    sendJson(response, 202, {
      ok: true,
      group_id: group.id,
      phase: result.group.status,
      round: result.group.current_round,
      delivery_status: { delivered: broadcast.delivered.length, failed: broadcast.failed.length },
    })
  }),

  route('POST', '/api/team/discuss/final', async ({ request, response, store }) => {
    const body = await readJsonBody<DiscussConcludeBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const text = requireNonEmptyString(body.text, 'text')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'discuss')

    const group = store.discussionOps.getActiveGroupForAgent(projectId, fromAgentId)
    if (!group) {
      throw new ConflictError('Agent is not in any active discussion group')
    }
    store.discussionOps.getGroupForWorkspace(group.id, projectId)

    if (group.status !== 'concluding') {
      throw new ConflictError(`Group is not in concluding phase (current: ${group.status})`)
    }

    const result = store.discussionOps.submitConclusion(group.id, fromAgentId, text)

    if (result.transitioned && result.newStatus === 'concluded') {
      const messages = store.discussionOps.getMessages(group.id)
      const reportText = formatSynthesisReport(result.group, result.members, messages)
      const orchId = `${projectId}:orchestrator`
      const writeFn = (ws: string, agentId: string, t: string) =>
        writeToAgentStdin(store, ws, agentId, t)
      injectToAgent(projectId, orchId, reportText, writeFn)
      handleConcludedPostActions(store, projectId, result.group.topic, reportText, orchId, writeFn, group.id)
      clearAllMemberQueues(projectId, result.members)
      markMembersOutOfDiscussion(store, projectId, result.members)
    }

    sendJson(response, 202, { ok: true, group_id: group.id, phase: result.group.status })
  }),

  route('POST', '/api/team/discuss/end', async ({ request, response, store }) => {
    const body = await readJsonBody<DiscussEndBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')

    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'discuss')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can end discussions')
      }
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const groupId =
      body.group_id ??
      (() => {
        const groups = store.discussionOps.getActiveGroupsForWorkspace(projectId)
        if (groups.length === 0) throw new ConflictError('No active discussion group')
        if (groups.length > 1) throw new BadRequestError('Multiple active groups, specify group_id')
        return groups[0]!.id
      })()

    store.discussionOps.getGroupForWorkspace(groupId, projectId)

    const group = store.discussionOps.endDiscussion(groupId, body.reason)
    const members = store.discussionOps.getMembers(groupId)

    const cancelText = formatCancelNotice(body.reason)
    const writeFn = (ws: string, agentId: string, t: string) =>
      writeToAgentStdin(store, ws, agentId, t)
    await broadcastToMembers(projectId, members, '', cancelText, writeFn)
    clearAllMemberQueues(projectId, members)
    markMembersOutOfDiscussion(store, projectId, members)

    sendJson(response, 200, { ok: true, group_id: group.id, status: group.status })
  }),

  route('POST', '/api/team/discuss/skip', async ({ request, response, store }) => {
    const body = await readJsonBody<DiscussSkipBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const workerName = requireNonEmptyString(body.worker_name, 'worker_name')

    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'discuss')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can skip workers')
      }
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const groupId =
      body.group_id ??
      (() => {
        const groups = store.discussionOps.getActiveGroupsForWorkspace(projectId)
        if (groups.length === 0) throw new ConflictError('No active discussion group')
        if (groups.length > 1) throw new BadRequestError('Multiple active groups, specify group_id')
        return groups[0]!.id
      })()

    store.discussionOps.getGroupForWorkspace(groupId, projectId)

    const members = store.discussionOps.getMembers(groupId)
    const target = members.find((m) => m.agent_name === workerName)
    if (!target) throw new BadRequestError(`Worker ${workerName} is not in this discussion group`)

    const result = store.discussionOps.skipMember(groupId, target.agent_id)
    store.markDiscussionLeft(projectId, target.agent_id)

    const writeFn = (ws: string, agentId: string, t: string) =>
      writeToAgentStdin(store, ws, agentId, t)

    if (result.transitioned) {
      if (result.newStatus === 'discussing') {
        const positions = result.members
          .filter((m) => m.initial_position !== null)
          .map((m) => ({ name: m.agent_name, text: m.initial_position! }))
        const bundleText = formatInitialBundle(positions, 1, result.group.max_rounds)
        const broadcast = await broadcastToMembers(
          projectId,
          result.members,
          '',
          bundleText,
          writeFn
        )
        handleBroadcastFailures(store, projectId, groupId, broadcast)
      } else if (result.newStatus === 'concluding') {
        const concludeText = formatConcludeInvite()
        await broadcastToMembers(projectId, result.members, '', concludeText, writeFn)
      } else if (result.newStatus === 'concluded') {
        const messages = store.discussionOps.getMessages(groupId)
        const reportText = formatSynthesisReport(result.group, result.members, messages)
        const orchId = `${projectId}:orchestrator`
        injectToAgent(projectId, orchId, reportText, writeFn)
        handleConcludedPostActions(
          store,
          projectId,
          result.group.topic,
          reportText,
          orchId,
          writeFn,
          groupId
        )
        clearAllMemberQueues(projectId, result.members)
        markMembersOutOfDiscussion(store, projectId, result.members)
      } else if (result.newStatus === 'cancelled') {
        clearAllMemberQueues(projectId, result.members)
        markMembersOutOfDiscussion(store, projectId, result.members)
      }
    }

    sendJson(response, 200, {
      ok: true,
      group_id: groupId,
      skipped: workerName,
      phase: result.group.status,
    })
  }),

  route('POST', '/api/team/discuss/steer', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      workspace_id: string
      group_id?: string
      text: string
      from_agent_id?: string
      token?: string
    }>(request)
    const projectId = requireNonEmptyString(body.workspace_id, 'workspace_id')
    const text = requireNonEmptyString(body.text, 'text')

    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'discuss')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can steer discussions')
      }
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const groupId =
      body.group_id ??
      (() => {
        const groups = store.discussionOps.getActiveGroupsForWorkspace(projectId)
        if (groups.length === 0) throw new ConflictError('No active discussion group')
        if (groups.length > 1) throw new BadRequestError('Multiple active groups, specify group_id')
        return groups[0]!.id
      })()

    store.discussionOps.getGroupForWorkspace(groupId, projectId)
    const group = store.discussionOps.steerDiscussion(groupId, text)

    const members = store.discussionOps.getMembers(groupId)
    const steerText = `[Hive 讨论：来自 Orchestrator 的引导]\n${text}`
    const writeFn = (ws: string, agentId: string, t: string) =>
      writeToAgentStdin(store, ws, agentId, t)
    const broadcast = await broadcastToMembers(projectId, members, '', steerText, writeFn)

    sendJson(response, 200, {
      ok: true,
      group_id: groupId,
      phase: group.status,
      delivery_status: { delivered: broadcast.delivered.length, failed: broadcast.failed.length },
    })
  }),

  route('POST', '/api/team/discuss/extend', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      workspace_id: string
      group_id?: string
      rounds?: number
      from_agent_id?: string
      token?: string
    }>(request)
    const projectId = requireNonEmptyString(body.workspace_id, 'workspace_id')
    const rounds = typeof body.rounds === 'number' ? body.rounds : 1

    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'discuss')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can extend discussions')
      }
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const groupId =
      body.group_id ??
      (() => {
        const groups = store.discussionOps.getActiveGroupsForWorkspace(projectId)
        if (groups.length === 0) throw new ConflictError('No active discussion group')
        if (groups.length > 1) throw new BadRequestError('Multiple active groups, specify group_id')
        return groups[0]!.id
      })()

    store.discussionOps.getGroupForWorkspace(groupId, projectId)
    const group = store.discussionOps.extendRounds(groupId, rounds)

    sendJson(response, 200, {
      ok: true,
      group_id: groupId,
      max_rounds: group.max_rounds,
      phase: group.status,
    })
  }),

  route('GET', '/api/team/discuss/active', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspace_id')
    if (!workspaceId) throw new BadRequestError('Missing workspace_id')

    requireUiTokenFromRequest(request, store.validateUiToken)

    const groups = store.discussionOps.getActiveGroupsForWorkspace(workspaceId)
    const payload = groups.map((g) => {
      const members = store.discussionOps.getMembers(g.id)
      const membersWithModel = members.map((m) => ({
        agent_id: m.agent_id,
        agent_name: m.agent_name,
        initial_position: m.initial_position,
        final_position: m.final_position,
        rounds_participated: m.rounds_participated,
        model_label: resolveCommandPresetId(store, workspaceId, m.agent_id),
      }))
      return {
        id: g.id,
        workspace_id: g.workspace_id,
        topic: g.topic,
        max_rounds: g.max_rounds,
        current_round: g.current_round,
        max_messages: g.max_messages,
        message_count: g.message_count,
        status: g.status,
        listen_mode: g.listen_mode,
        created_by: g.created_by,
        created_at: g.created_at,
        concluded_at: g.concluded_at,
        members: membersWithModel,
      }
    })
    sendJson(response, 200, payload)
  }),

  route('GET', '/api/team/discuss/messages', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspace_id')
    const groupId = url.searchParams.get('group_id')
    if (!workspaceId) throw new BadRequestError('Missing workspace_id')
    if (!groupId) throw new BadRequestError('Missing group_id')

    requireUiTokenFromRequest(request, store.validateUiToken)

    store.discussionOps.getGroupForWorkspace(groupId, workspaceId)
    const messages = store.discussionOps.getMessages(groupId)
    const members = store.discussionOps.getMembers(groupId)
    const payload = messages.map((m) => {
      const member = members.find((mb) => mb.agent_id === m.from_agent_id)
      return {
        sequence: m.sequence,
        group_id: m.group_id,
        round: m.round,
        from_agent_id: m.from_agent_id,
        from_agent_name: member?.agent_name ?? m.from_agent_id,
        text: m.text,
        created_at: m.created_at,
        model_label: resolveCommandPresetId(store, workspaceId, m.from_agent_id),
      }
    })
    sendJson(response, 200, payload)
  }),

  route('GET', '/api/team/discuss/timeline', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspace_id')
    const groupId = url.searchParams.get('group_id')
    if (!workspaceId) throw new BadRequestError('Missing workspace_id')
    if (!groupId) throw new BadRequestError('Missing group_id')

    requireUiTokenFromRequest(request, store.validateUiToken)

    const group = store.discussionOps.getGroupForWorkspace(groupId, workspaceId)
    const members = store.discussionOps.getMembers(groupId)
    const messages = store.discussionOps.getMessages(groupId)

    type TimelineEvent = {
      type: 'created' | 'initial' | 'discuss' | 'system' | 'conclude' | 'concluded'
      timestamp: number
      agent_id: string | null
      agent_name: string | null
      round: number
      text: string
    }

    const events: TimelineEvent[] = []

    events.push({
      type: 'created',
      timestamp: group.created_at,
      agent_id: null,
      agent_name: null,
      round: 0,
      text: JSON.stringify({
        topic: group.topic,
        members: members.map((m) => m.agent_name),
        max_rounds: group.max_rounds,
      }),
    })

    for (const msg of messages) {
      const member = members.find((mb) => mb.agent_id === msg.from_agent_id)
      events.push({
        type: msg.message_type as TimelineEvent['type'],
        timestamp: msg.created_at,
        agent_id: msg.from_agent_id,
        agent_name: member?.agent_name ?? msg.from_agent_id,
        round: msg.round,
        text: msg.text,
      })
    }

    if (group.concluded_at) {
      events.push({
        type: 'concluded',
        timestamp: group.concluded_at,
        agent_id: null,
        agent_name: null,
        round: group.current_round,
        text: group.status,
      })
    }

    events.sort((a, b) => a.timestamp - b.timestamp)

    sendJson(response, 200, { group_id: groupId, status: group.status, events })
  }),
]
