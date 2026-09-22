import { isOpenTargetId } from './open-target-commands.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { OpenWorkspaceBody, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const openWorkspaceRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/workspaces/:workspaceId/open',
    async ({ openWorkspaceService, params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const body = await readJsonBody<OpenWorkspaceBody>(request)
      if (!isOpenTargetId(body.target_id)) {
        sendJson(response, 400, { error: 'Unknown open target', target_id: body.target_id })
        return
      }

      // Preserve this endpoint's existing missing-workspace response body.
      let workspacePath: string
      try {
        workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const result = await openWorkspaceService({
        path: workspacePath,
        targetId: body.target_id,
      })

      if (result.ok) {
        sendJson(response, 200, {
          ok: true,
          effective_target_id: result.effectiveTargetId,
        })
        return
      }

      // Drop stderr from the wire response — defense in depth. The frontend
      // never renders raw stderr (toast text is localized via error_code), so
      // there's no reason to ship the OS-level message to the browser where
      // it would live in the devtools network log.
      sendJson(response, 502, {
        ok: false,
        effective_target_id: result.effectiveTargetId,
        error_code: result.errorCode,
      })
    }
  ),
]
