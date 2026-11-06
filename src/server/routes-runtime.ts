import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { ConfigureAgentLaunchBody, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeLiveAgentRun } from './workflow-http-serializers.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

export const runtimeRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/switch',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const agentId = getRequiredParam(response, params, 'agentId', 'Agent id is required')
      if (!workspaceId || !agentId) return
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const body = await readJsonBody<{ command_preset_id?: unknown }>(request)
      if (typeof body?.command_preset_id !== 'string' || !body.command_preset_id.trim())
        throw new BadRequestError('Command preset id is required')
      const run = await store.switchAgentCommandPreset(
        workspaceId,
        agentId,
        body.command_preset_id,
        {
          hivePort: String(request.socket.localPort ?? ''),
        }
      )
      sendJson(response, 201, { run_id: run.runId })
    }
  ),
  route('GET', '/api/ui/workspaces/:workspaceId/runs', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

    sendJson(response, 200, store.listTerminalRuns(workspaceId))
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/shell/start',
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

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const run = await store.startWorkspaceShell(workspaceId)
      const summary = store
        .listTerminalRuns(workspaceId)
        .find((terminalRun) => terminalRun.run_id === run.runId)
      sendJson(response, 201, {
        agent_id: getWorkspaceShellAgentId(workspaceId),
        agent_name: summary?.agent_name ?? 'Shell',
        run_id: run.runId,
        status: run.status,
        terminal_input_profile: summary?.terminal_input_profile ?? 'default',
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/shell/:runId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and run id are required'
      )
      const runId = getRequiredParam(
        response,
        params,
        'runId',
        'Workspace id and run id are required'
      )
      if (!workspaceId || !runId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      if (!store.closeWorkspaceShell(workspaceId, runId)) {
        sendJson(response, 404, { error: 'Shell run not found' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
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

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const body = await readJsonBody<ConfigureAgentLaunchBody>(request)
      store.configureAgentLaunch(workspaceId, agentId, {
        command: body.command,
        commandPresetId: body.command_preset_id ?? null,
        ...(body.args ? { args: body.args } : {}),
      })
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/runtime/runs/:runId/stop', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

    store.stopAgentRun(runId)
    sendJson(response, 202, { ok: true })
  }),
  route('GET', '/api/runtime/runs/:runId', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

    const run = store.findLiveRun(runId)
    if (!run) {
      sendJson(response, 404, { error: 'Run not found' })
      return
    }
    sendJson(response, 200, serializeLiveAgentRun(run))
  }),
]
