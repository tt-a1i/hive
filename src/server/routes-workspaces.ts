import { ForbiddenError } from './http-errors.js'
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

const requireUiOrigin = (
  host: string | undefined,
  origin: string | undefined,
  referer: string | undefined,
  secFetchMode: string | undefined
) => {
  if (!host) {
    throw new ForbiddenError('UI endpoint requires same-origin browser request')
  }

  if (secFetchMode !== 'cors' && secFetchMode !== 'same-origin') {
    throw new ForbiddenError('UI endpoint requires same-origin browser request')
  }

  const expectedOrigin = `http://${host}`
  const trustedValues = [origin, referer].filter(
    (value): value is string => typeof value === 'string'
  )
  const isSameOrigin = trustedValues.some((value) => {
    try {
      const url = new URL(value)
      return url.origin === expectedOrigin
    } catch {
      return false
    }
  })
  if (!isSameOrigin) {
    throw new ForbiddenError('UI endpoint requires same-origin browser request')
  }
}

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces', ({ response, store }) => {
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
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

    requireUiOrigin(
      typeof request.headers.host === 'string' ? request.headers.host : undefined,
      typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      typeof request.headers.referer === 'string' ? request.headers.referer : undefined,
      typeof request.headers['sec-fetch-mode'] === 'string'
        ? request.headers['sec-fetch-mode']
        : undefined
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

      const body = await readJsonBody<LaunchAgentBody>(request)
      sendJson(
        response,
        201,
        await store.startAgent(workspaceId, agentId, { hivePort: body.hive_port })
      )
    }
  ),
]
