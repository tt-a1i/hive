import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { ConfigureAgentLaunchBody, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const runtimeRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/config',
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

      const body = await readJsonBody<ConfigureAgentLaunchBody>(request)
      store.configureAgentLaunch(
        workspaceId,
        agentId,
        body.args ? { args: body.args, command: body.command } : { command: body.command }
      )
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/runtime/runs/:runId/stop', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      store.validateUiToken
    )

    store.stopAgentRun(runId)
    sendJson(response, 202, { ok: true })
  }),
  route('GET', '/api/runtime/runs/:runId', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      store.validateUiToken
    )

    sendJson(response, 200, store.getLiveRun(runId))
  }),
]
