import { buildActionCenterSummary } from './action-center-summary.js'
import { serializeDispatchMessage } from './dispatch-message-serializer.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { buildTeamRecapMarkdown } from './team-recap.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const RECAP_DISPATCH_LIMIT = 12

export const actionCenterRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/action-center',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }
      sendJson(response, 200, buildActionCenterSummary({ store, workspaceId }))
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/questions/:questionId/reply',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const { workspaceId, questionId } = params
      if (!workspaceId || !questionId)
        throw new BadRequestError('Workspace and question are required')
      const body = await readJsonBody<{ text?: unknown } | null>(request)
      if (typeof body?.text !== 'string' || !body.text.trim())
        throw new BadRequestError('An answer is required')
      const actor = `${workspaceId}:orchestrator`
      const input = store.getDispatchReplyInput(workspaceId, actor, questionId, body.text)
      if (store.getDispatchQuestion(workspaceId, actor, questionId).status !== 'pending')
        throw new ConflictError('This question no longer needs an answer')
      const message = store.sendDispatchMessage(workspaceId, actor, input)
      sendJson(response, 202, { ok: true, message: serializeDispatchMessage(message) })
    }
  ),
  route('GET', '/api/workspaces/:workspaceId/recap', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const workspace = store.listWorkspaces().find((entry) => entry.id === workspaceId)
    if (!workspace) {
      sendJson(response, 404, { error: 'Workspace not found' })
      return
    }

    const now = Date.now()
    const markdown = buildTeamRecapMarkdown({
      dispatches: store.listRecentDispatches(workspaceId, RECAP_DISPATCH_LIMIT),
      now,
      workers: store.listWorkers(workspaceId),
      workspaceName: workspace.name,
    })
    sendJson(response, 200, { generated_at: now, markdown })
  }),
]
