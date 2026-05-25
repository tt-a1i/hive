import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CancelTaskBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
} from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const FAILED_KEYWORDS = /\b(failed|blocked|error|失败|阻塞)\b/i

export const inferPriorityTag = (priority: string | undefined, text: string): string | null => {
  if (priority === 'failed') return '[FAILED]'
  if (priority === 'blocked') return '[BLOCKED]'
  if (priority === 'normal') return null
  if (FAILED_KEYWORDS.test(text)) return '[FAILED]'
  return null
}

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'send')
    const dispatch = await store.dispatchTaskByWorkerName(projectId, to, text, {
      fromAgentId,
      hivePort: String(request.socket.localPort ?? ''),
    })

    // Task-dispatch linking: --task <id> or --create-task
    let taskId: string | null = null
    if (typeof body.task_id === 'string' && body.task_id.trim()) {
      store.taskService.linkDispatchToTask(dispatch.id, body.task_id, fromAgentId)
      taskId = body.task_id
    } else if (body.create_task === true) {
      const task = store.taskService.createTask({
        workspaceId: projectId,
        title: text.length > 120 ? text.slice(0, 117) + '...' : text,
        source: 'orch',
        agentId: fromAgentId,
      })
      store.taskService.linkDispatchToTask(dispatch.id, task.id, fromAgentId)
      taskId = task.id
    }

    sendJson(response, 202, { dispatch_id: dispatch.id, ok: true, task_id: taskId })
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const reason = requireNonEmptyString(body.reason, 'reason')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'cancel')
    const result = store.cancelTask(projectId, dispatchId, { fromAgentId, reason })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const rawText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'report')
    if (typeof body.checkpoint === 'string' && body.checkpoint.trim()) {
      const db = store.getDb()
      const activeRun = store.getActiveRunByAgentId(projectId, fromAgentId)
      if (activeRun) {
        db.prepare('UPDATE agent_runs SET checkpoint_json = ?, updated_at = ? WHERE run_id = ?')
          .run(body.checkpoint, Date.now(), activeRun.runId)
      }
    }
    const priorityTag = inferPriorityTag(
      typeof body.priority === 'string' ? body.priority : undefined,
      rawText
    )
    const resultText = priorityTag ? `${priorityTag} ${rawText}` : rawText
    const reportInput = {
      artifacts: getArtifacts(body.artifacts),
      ...(typeof body.dispatch_id === 'string' ? { dispatchId: body.dispatch_id } : {}),
      requireActiveRun: true,
      text: resultText,
    }
    if (typeof body.status === 'string') {
      const result = store.reportTask(projectId, fromAgentId, {
        ...reportInput,
        status: body.status,
      })
      if (result.dispatch?.taskId) {
        store.taskService.recordSuggestion(
          result.dispatch.taskId,
          result.dispatch.id,
          { reportText: resultText, status: body.status },
          fromAgentId
        )
      }
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    } else {
      const result = store.reportTask(projectId, fromAgentId, reportInput)
      if (result.dispatch?.taskId) {
        store.taskService.recordSuggestion(
          result.dispatch.taskId,
          result.dispatch.id,
          { reportText: resultText },
          fromAgentId
        )
      }
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    }
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'status')
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: getArtifacts(body.artifacts),
      requireActiveRun: true,
      text: resultText,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
    return
  }),
]
