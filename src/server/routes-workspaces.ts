import { autostartAgent, autostartOrchestrator } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
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
import { getOrchestratorId } from './workspace-store-support.js'

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
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    const workspace = store.createWorkspace(body.path, body.name)

    const autostart = body.autostart_orchestrator !== false
    if (!autostart) {
      sendJson(response, 201, {
        ...workspace,
        orchestrator_start: { ok: false, error: null, run_id: null },
      })
      return
    }

    seedOrchestratorLaunchConfig(
      store,
      store.settings,
      workspace.id,
      body.command_preset_id ?? null
    )
    // Spawn failure must NOT block workspace creation — see AGENTS.md §1
    // (no try/catch fallbacks in production code, but `autostartOrchestrator`
    // captures the failure as a structured result instead of throwing).
    const orchestratorStart = await autostartOrchestrator(
      store,
      workspace.id,
      getOrchestratorId(workspace.id),
      body.hive_port ?? ''
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

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<CreateWorkerBody>(request)
      const worker = store.addWorker(workspaceId, body)
      const presetId = body.command_preset_id ?? null
      if (presetId) {
        const preset = store.settings.getCommandPreset(presetId)
        if (!preset) throw new Error(`Command preset not found: ${presetId}`)
        store.configureAgentLaunch(workspaceId, worker.id, {
          args: preset.args,
          command: preset.command,
          commandPresetId: preset.id,
        })
      }

      const agentStart =
        body.autostart === true
          ? await autostartAgent(store, workspaceId, worker.id, body.hive_port ?? '', {
              missingConfigError: 'No worker launch config available',
            })
          : { ok: false, error: null, run_id: null }

      sendJson(response, 201, {
        ...getSerializedWorker(workspaceId, worker.id, store.listWorkers),
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

      const body = await readJsonBody<LaunchAgentBody>(request)
      if (
        agentId === getOrchestratorId(workspaceId) &&
        !store.peekAgentLaunchConfig(workspaceId, agentId)
      ) {
        seedOrchestratorLaunchConfig(store, store.settings, workspaceId)
      }
      sendJson(
        response,
        201,
        await store.startAgent(workspaceId, agentId, { hivePort: body.hive_port })
      )
    }
  ),
]
