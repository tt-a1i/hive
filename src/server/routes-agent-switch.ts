import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const agentSwitchRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/agents/:agentId/switch',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const { workspaceId, agentId } = params
      if (!workspaceId || !agentId) throw new BadRequestError('Workspace and agent are required')
      const body = await readJsonBody<Record<string, unknown>>(request)
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !['command_preset_id', 'startup_command', 'restart'].includes(key)
        )
      )
        throw new BadRequestError('Invalid CLI switch request')
      if (typeof body.restart !== 'boolean') throw new BadRequestError('restart must be a boolean')
      const preset = body.command_preset_id
      const startup = body.startup_command
      if ((preset !== undefined) === (startup !== undefined))
        throw new BadRequestError('Select exactly one command preset or startup command')
      if (preset !== undefined && (typeof preset !== 'string' || !preset.trim()))
        throw new BadRequestError('Invalid command preset')
      if (startup !== undefined && (typeof startup !== 'string' || !startup.trim()))
        throw new BadRequestError('Invalid startup command')
      store.getAgent(workspaceId, agentId)
      const previous = store.peekAgentLaunchConfig(workspaceId, agentId)
      const config =
        typeof preset === 'string'
          ? previous?.commandPresetId === preset
            ? previous
            : resolveCommandPresetLaunchConfig(store.settings, preset)
          : resolveStartupCommandLaunchConfig(store.settings, startup as string)
      if (!config) throw new BadRequestError('Unknown command preset or empty startup command')
      const run = await store.switchAgentLaunch(
        workspaceId,
        agentId,
        { ...(previous?.cwd !== undefined ? { cwd: previous.cwd } : {}), ...config },
        {
          restart: body.restart,
          hivePort: String(request.socket.localPort ?? ''),
        }
      )
      sendJson(response, 200, { run_id: run?.runId ?? null })
    }
  ),
]
