import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import type { DispatchStatus } from './dispatch-ledger-store.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const DISPATCH_STATUSES = new Set<DispatchStatus>(['queued', 'submitted', 'reported'])
const MAX_DISPATCH_LIMIT = 100
const MAX_DISPATCH_OFFSET = 100_000

const readBoundedInt = (
  response: Parameters<typeof sendJson>[0],
  value: string | null,
  name: string,
  fallback: number,
  max: number
) => {
  if (value === null) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    sendJson(response, 400, { error: `${name} must be a non-negative integer` })
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    sendJson(response, 400, { error: `${name} must be between 0 and ${max}` })
    return null
  }
  return parsed
}

const isDispatchStatus = (value: string): value is DispatchStatus =>
  DISPATCH_STATUSES.has(value as DispatchStatus)

export const dispatchRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches',
    ({ params, request, response, store }) => {
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
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.has('status')) {
        sendJson(response, 400, { error: 'Use state instead of status for dispatch filtering' })
        return
      }
      const state = url.searchParams.get('state')
      if (state !== null && !isDispatchStatus(state)) {
        sendJson(response, 400, { error: 'state must be queued, submitted, or reported' })
        return
      }
      const limit = readBoundedInt(
        response,
        url.searchParams.get('limit'),
        'limit',
        MAX_DISPATCH_LIMIT,
        MAX_DISPATCH_LIMIT
      )
      if (limit === null) return
      const offset = readBoundedInt(
        response,
        url.searchParams.get('offset'),
        'offset',
        0,
        MAX_DISPATCH_OFFSET
      )
      if (offset === null) return
      const options = {
        limit,
        offset,
        ...(state ? { status: state } : {}),
      }
      sendJson(
        response,
        200,
        store.listDispatches(workspaceId, options).map(serializeDispatchRecord)
      )
    }
  ),
]
