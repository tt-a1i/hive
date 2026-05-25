import { BadRequestError, ForbiddenError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { TaskSource, TaskStatus } from './task-service.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

interface CreateTaskBody {
  workspace_id: string
  title: string
  source?: TaskSource
  source_ref?: string
  from_agent_id?: string
  token?: string
}

interface UpdateStatusBody {
  status: TaskStatus
  from_agent_id?: string
  token?: string
}

interface LinkDispatchBody {
  dispatch_id: string
  from_agent_id?: string
  token?: string
}

const requireTaskId = (id: string | undefined): string => {
  if (!id) {
    throw new BadRequestError('Missing task id')
  }
  return id
}

export const taskApiRoutes: RouteDefinition[] = [
  route('POST', '/api/team/tasks', async ({ request, response, store }) => {
    const body = await readJsonBody<CreateTaskBody>(request)

    if (!body.workspace_id || typeof body.workspace_id !== 'string') {
      throw new BadRequestError('Missing workspace_id')
    }
    if (!body.title || typeof body.title !== 'string') {
      throw new BadRequestError('Missing title')
    }

    let agentId: string | undefined
    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: body.workspace_id,
      })
      requireCommandForRole(agent, 'task')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can create tasks')
      }
      agentId = body.from_agent_id
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const task = store.taskService.createTask({
      workspaceId: body.workspace_id,
      title: body.title,
      source: body.source ?? 'orch',
      ...(body.source_ref ? { sourceRef: body.source_ref } : {}),
      ...(agentId ? { agentId } : {}),
    })

    sendJson(response, 201, { ok: true, task })
  }),

  route('GET', '/api/team/tasks', ({ request, response, store }) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const workspaceId = url.searchParams.get('workspace_id')
    if (!workspaceId) {
      throw new BadRequestError('Missing workspace_id query parameter')
    }

    const token = url.searchParams.get('token')
    const fromAgentId = url.searchParams.get('from_agent_id')

    if (fromAgentId) {
      authenticateCliAgent({
        fromAgentId,
        getAgent: store.getAgent,
        token: token ?? undefined,
        validateToken: store.validateAgentToken,
        workspaceId,
      })
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const statusFilter = url.searchParams.get('status') as TaskStatus | null
    const seqParam = url.searchParams.get('seq')

    if (seqParam) {
      const seq = Number(seqParam)
      if (!Number.isFinite(seq) || seq < 1) {
        throw new BadRequestError('Invalid seq parameter')
      }
      const task = store.taskService.getTaskBySeq(workspaceId, seq)
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }
      sendJson(response, 200, { task })
      return
    }

    const tasks = store.taskService.listTasks(
      workspaceId,
      statusFilter ? { status: statusFilter } : undefined
    )

    sendJson(response, 200, { tasks })
  }),

  route('GET', '/api/team/tasks/:id', ({ request, response, store, params }) => {
    const taskId = requireTaskId(params.id)
    const url = new URL(request.url ?? '', 'http://localhost')
    const workspaceId = url.searchParams.get('workspace_id')

    const token = url.searchParams.get('token')
    const fromAgentId = url.searchParams.get('from_agent_id')

    if (fromAgentId && workspaceId) {
      authenticateCliAgent({
        fromAgentId,
        getAgent: store.getAgent,
        token: token ?? undefined,
        validateToken: store.validateAgentToken,
        workspaceId,
      })
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const result = store.taskService.getTask(taskId)
    if (!result) {
      sendJson(response, 404, { error: 'Task not found' })
      return
    }

    sendJson(response, 200, result)
  }),

  route('POST', '/api/team/tasks/:id/status', async ({ request, response, store, params }) => {
    const taskId = requireTaskId(params.id)
    const body = await readJsonBody<UpdateStatusBody>(request)

    if (!body.status) {
      throw new BadRequestError('Missing status')
    }

    const existing = store.taskService.getTask(taskId)
    if (!existing) {
      sendJson(response, 404, { error: 'Task not found' })
      return
    }

    let agentId: string | undefined
    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: existing.task.workspaceId,
      })
      requireCommandForRole(agent, 'task')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can update task status')
      }
      agentId = body.from_agent_id
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const task = store.taskService.updateTaskStatus(taskId, body.status, agentId)
    sendJson(response, 200, { ok: true, task })
  }),

  route('POST', '/api/team/tasks/:id/link', async ({ request, response, store, params }) => {
    const taskId = requireTaskId(params.id)
    const body = await readJsonBody<LinkDispatchBody>(request)

    if (!body.dispatch_id) {
      throw new BadRequestError('Missing dispatch_id')
    }

    const existing = store.taskService.getTask(taskId)
    if (!existing) {
      sendJson(response, 404, { error: 'Task not found' })
      return
    }

    let agentId: string | undefined
    if (body.from_agent_id) {
      const agent = authenticateCliAgent({
        fromAgentId: body.from_agent_id,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: existing.task.workspaceId,
      })
      requireCommandForRole(agent, 'task')
      if (agent.role !== 'orchestrator') {
        throw new ForbiddenError('Only orchestrator can link dispatches to tasks')
      }
      agentId = body.from_agent_id
    } else {
      requireUiTokenFromRequest(request, store.validateUiToken)
    }

    const ok = store.taskService.linkDispatchToTask(body.dispatch_id, taskId, agentId)
    sendJson(response, ok ? 200 : 400, { ok })
  }),
]
