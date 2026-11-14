import type { IncomingMessage } from 'node:http'

import type { TeamListOpenDispatchPayload } from '../shared/types.js'

import { PtyInactiveError } from './http-errors.js'
import { autostartOrchestrator } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { CreateWorkspaceBody, RouteDefinition, UserInputBody } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { validateWorkspacePath } from './workspace-path-validation.js'
import { getOrchestratorId, getWorkflowAgentId } from './workspace-store-support.js'
import { resolveWorkspaceUiLanguage, writeWorkspaceUiLanguage } from './workspace-ui-language.js'

/* #35: fold each worker's open dispatches (id, age, status, task preview)
   into the team list payload. Display-only ages — no timeout or heartbeat is
   derived from them; `queued` rows age from createdAt (submittedAt is null
   until delivery). */
const serializeTeamListWithOpenDispatches = (
  store: Parameters<typeof enrichTeamList>[1] &
    Pick<RuntimeStore, 'listOpenDispatches' | 'listWorkers'>,
  workspaceId: string,
  options: { includeAvatar?: boolean } = {}
) => {
  const now = Date.now()
  const workflowAgentId = getWorkflowAgentId(workspaceId)
  const openByWorker = new Map<string, TeamListOpenDispatchPayload[]>()
  for (const dispatch of store.listOpenDispatches(workspaceId)) {
    if (dispatch.status !== 'queued' && dispatch.status !== 'submitted') continue
    // Workflow-owned dispatches are the runner's business: handing their ids
    // to the orchestrator invites a `team cancel` that wedges the run.
    if (dispatch.workflowRunId !== null || dispatch.fromAgentId === workflowAgentId) continue
    const list = openByWorker.get(dispatch.toAgentId) ?? []
    list.push({
      id: dispatch.id,
      status: dispatch.status,
      age_minutes: Math.max(
        0,
        Math.floor((now - (dispatch.submittedAt ?? dispatch.createdAt)) / 60_000)
      ),
      task_preview: dispatch.text.slice(0, 60),
    })
    openByWorker.set(dispatch.toAgentId, list)
  }
  return enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map((worker) =>
    serializeTeamListItem(worker, openByWorker.get(worker.id), options)
  )
}

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
    const workspacePath = validateWorkspacePath(body.path)
    const workspace = store.createWorkspace(workspacePath, body.name)
    const language = resolveWorkspaceUiLanguage(store.settings, workspace.id, body.ui_language)
    writeWorkspaceUiLanguage(store.settings, workspace.id, language)
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

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
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

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

    sendJson(
      response,
      200,
      serializeTeamListWithOpenDispatches(store, workspaceId, { includeAvatar: true })
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

    // Polling `team list` is a natural post-restart wakeup: flush any durable
    // notices stranded for the caller now that its PTY is reachable again.
    store.drainReportOutbox(workspaceId, agent.id)
    store.drainDispatchMessageOutbox(workspaceId, agent.id)

    sendJson(response, 200, serializeTeamListWithOpenDispatches(store, workspaceId))
  }),
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

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const body = await readJsonBody<UserInputBody>(request)
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        sendJson(response, 400, { error: 'text is required' })
        return
      }
      const orchestratorId = getOrchestratorId(workspaceId)
      if (!store.getActiveRunByAgentId(workspaceId, orchestratorId)) {
        throw new PtyInactiveError(`No active run for agent: ${orchestratorId}`)
      }

      await store.deliverUserInput(workspaceId, orchestratorId, body.text)
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

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

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
