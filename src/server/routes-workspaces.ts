import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CreateWorkerBody,
  CreateWorkspaceBody,
  LaunchAgentBody,
  RouteDefinition,
  UserInputBody,
} from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const getSerializedWorker = (
  workspaceId: string,
  workerId: string,
  listWorkers: RuntimeStore['listWorkers']
) => {
  const worker = listWorkers(workspaceId).find((item) => item.id === workerId)
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`)
  }
  return serializeTeamListItem(worker)
}

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces', ({ request, response, store }) => {
    requireUiTokenFromRequest(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      store.validateUiToken
    )
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      store.validateUiToken
    )
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    sendJson(response, 201, store.createWorkspace(body.path, body.name))
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/team', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      store.validateUiToken
    )

    sendJson(response, 200, store.listWorkers(workspaceId).map(serializeTeamListItem))
  }),
  route('GET', '/api/workspaces/:workspaceId/team', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    const agentId = request.headers['x-hive-agent-id']
    const token = request.headers['x-hive-agent-token']
    const agent = authenticateCliAgent({
      fromAgentId: typeof agentId === 'string' ? agentId : undefined,
      getAgent: store.getAgent,
      token: typeof token === 'string' ? token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId,
    })
    requireCommandForRole(agent, 'list')

    sendJson(response, 200, store.listWorkers(workspaceId).map(serializeTeamListItem))
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(
        typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
        store.validateUiToken
      )

      const body = await readJsonBody<CreateWorkerBody>(request)
      const worker = store.addWorker(workspaceId, body)
      sendJson(response, 201, getSerializedWorker(workspaceId, worker.id, store.listWorkers))
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/user-input',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(
        typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
        store.validateUiToken
      )

      const body = await readJsonBody<UserInputBody>(request)
      store.recordUserInput(workspaceId, `${workspaceId}:orchestrator`, body.text)
      sendJson(response, 202, { ok: true })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/start',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) {
        return
      }

      requireUiTokenFromRequest(
        typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
        store.validateUiToken
      )

      const body = await readJsonBody<LaunchAgentBody>(request)
      sendJson(
        response,
        201,
        await store.startAgent(workspaceId, agentId, { hivePort: body.hive_port })
      )
    }
  ),
]
