import type { IncomingMessage } from 'node:http'

import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { autostartAgent, autostartOrchestrator } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CreateWorkerBody,
  CreateWorkspaceBody,
  RouteDefinition,
  UserInputBody,
} from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { validateWorkspacePath } from './workspace-path-validation.js'
import { getOrchestratorId } from './workspace-store-support.js'

const getSerializedWorker = (workspaceId: string, workerId: string, store: RuntimeStore) => {
  const worker = store.listWorkers(workspaceId).find((item) => item.id === workerId)
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`)
  }
  const [enriched] = enrichTeamList(workspaceId, store, [worker])
  if (!enriched) throw new Error(`Worker enrichment failed: ${workerId}`)
  return serializeTeamListItem(enriched)
}

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
    const workspacePath = validateWorkspacePath(body.path)
    const workspace = store.createWorkspace(workspacePath, body.name)
    seedOrchestratorLaunchConfig(
      store,
      store.settings,
      workspace.id,
      body.command_preset_id ?? null,
      startupCommand
    )

    const autostart = body.autostart_orchestrator !== false
    if (!autostart) {
      sendJson(response, 201, {
        ...workspace,
        orchestrator_start: { ok: false, error: null, run_id: null },
      })
      return
    }

    // Spawn failure must NOT block workspace creation — see AGENTS.md §1
    // (no try/catch fallbacks in production code, but `autostartOrchestrator`
    // captures the failure as a structured result instead of throwing).
    const orchestratorStart = await autostartOrchestrator(
      store,
      workspace.id,
      getOrchestratorId(workspace.id),
      getRuntimePort(request)
    )
    sendJson(response, 201, { ...workspace, orchestrator_start: orchestratorStart })
  }),
  route('DELETE', '/api/workspaces/:workspaceId', async ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)
    await store.deleteWorkspace(workspaceId)
    response.statusCode = 204
    response.end()
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

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(
      response,
      200,
      enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(serializeTeamListItem)
    )
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

    sendJson(
      response,
      200,
      enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(serializeTeamListItem)
    )
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

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<CreateWorkerBody>(request)
      const presetId = body.command_preset_id ?? null
      const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
      const launchConfig = startupCommand?.trim()
        ? resolveStartupCommandLaunchConfig(store.settings, startupCommand, presetId)
        : presetId
          ? resolveCommandPresetLaunchConfig(store.settings, presetId)
          : undefined
      if (presetId && !startupCommand?.trim() && !launchConfig) {
        throw new Error(`Command preset not found: ${presetId}`)
      }
      const worker = store.addWorker(workspaceId, body)
      if (launchConfig) {
        try {
          store.configureAgentLaunch(workspaceId, worker.id, launchConfig)
        } catch (error) {
          store.deleteWorker(workspaceId, worker.id)
          throw error
        }
      }

      const agentStart =
        body.autostart === true
          ? await autostartAgent(store, workspaceId, worker.id, getRuntimePort(request), {
              missingConfigError: 'No worker launch config available',
            })
          : { ok: false, error: null, run_id: null }

      sendJson(response, 201, {
        ...getSerializedWorker(workspaceId, worker.id, store),
        agent_start: agentStart,
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/workers/:workerId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      store.deleteWorker(workspaceId, workerId)
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/workers/:workerId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<{ name?: string }>(request)
      if (typeof body.name !== 'string') {
        sendJson(response, 400, { error: 'name is required' })
        return
      }
      store.renameWorker(workspaceId, workerId, body.name)
      sendJson(response, 200, getSerializedWorker(workspaceId, workerId, store))
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

      requireUiTokenFromRequest(request, store.validateUiToken)

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

      requireUiTokenFromRequest(request, store.validateUiToken)

      if (
        agentId === getOrchestratorId(workspaceId) &&
        !store.peekAgentLaunchConfig(workspaceId, agentId)
      ) {
        seedOrchestratorLaunchConfig(store, store.settings, workspaceId)
      }
      const run = await store.startAgent(workspaceId, agentId, {
        hivePort: getRuntimePort(request),
      })
      sendJson(response, 201, { run_id: run.runId })
    }
  ),
]
