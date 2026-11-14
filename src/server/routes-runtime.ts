import { resolveStartupCommandLaunchConfig } from './agent-launch-resolver.js'
import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { ConfigureAgentLaunchBody, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeLiveAgentRun } from './workflow-http-serializers.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

export const runtimeRoutes: RouteDefinition[] = [
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
    'GET',
    '/api/workspaces/:workspaceId/agents/:agentId/config',
    ({ params, request, response, store }) => {
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
      if (!workspaceId || !agentId) return
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      store.getAgent(workspaceId, agentId)
      const config = store.peekAgentLaunchConfig(workspaceId, agentId)
      if (!config) {
        sendJson(response, 404, { error: 'Agent launch config not found' })
        return
      }
      sendJson(response, 200, {
        command: config.command,
        args: config.args ?? [],
        command_preset_id: config.commandPresetId ?? null,
        cwd: config.cwd ?? null,
        interactive_command: config.interactiveCommand ?? null,
        preset_augmentation_disabled: config.presetAugmentationDisabled ?? false,
        resume_args_template: config.resumeArgsTemplate ?? null,
        session_id_capture: config.sessionIdCapture ?? null,
      })
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
      if (body.startup_command !== undefined) {
        if (
          typeof body.startup_command !== 'string' ||
          body.command !== undefined ||
          body.command_preset_id != null
        )
          throw new BadRequestError('Invalid startup command')
        const resolved = resolveStartupCommandLaunchConfig(store.settings, body.startup_command)
        if (!resolved) throw new BadRequestError('Startup command must not be empty')
        store.configureAgentLaunch(workspaceId, agentId, resolved)
      } else {
        if (
          typeof body.command !== 'string' ||
          !body.command.trim() ||
          (body.args !== undefined &&
            (!Array.isArray(body.args) || body.args.some((arg) => typeof arg !== 'string')))
        )
          throw new BadRequestError('Invalid agent command')
        const previous = store.peekAgentLaunchConfig(workspaceId, agentId)
        const presetId = body.command_preset_id ?? null
        const same =
          previous?.command === body.command && (previous.commandPresetId ?? null) === presetId
        store.configureAgentLaunch(workspaceId, agentId, {
          ...(same ? previous : {}),
          command: body.command,
          commandPresetId: presetId,
          ...(body.args ? { args: body.args } : {}),
        })
      }
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
