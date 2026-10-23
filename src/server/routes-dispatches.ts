import { readDispatchArtifact } from './dispatch-artifact-reader.js'
import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import type { DispatchStatus } from './dispatch-ledger-store.js'
import { HttpError } from './http-errors.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { serializeDispatchMessage } from './routes-team-messages.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const DISPATCH_STATUSES = new Set<DispatchStatus>(['queued', 'submitted', 'reported', 'cancelled'])
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
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/artifacts/:artifactIndex',
    async ({ params, request, response, store }) => {
      response.setHeader('cache-control', 'no-store')
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const { workspaceId, dispatchId, artifactIndex } = params
      if (
        !workspaceId ||
        !dispatchId ||
        !artifactIndex ||
        !/^(0|[1-9][0-9]*)$/.test(artifactIndex)
      ) {
        throw new HttpError(400, 'Workspace, dispatch and non-negative artifact index are required')
      }
      const index = Number(artifactIndex)
      if (!Number.isSafeInteger(index)) throw new HttpError(400, 'Artifact index is too large')
      const workspace = store.listWorkspaces().find((item) => item.id === workspaceId)
      if (!workspace) throw new HttpError(404, 'Workspace not found')
      const dispatch = store.getDispatch(workspaceId, dispatchId)
      if (!dispatch || dispatch.workspaceId !== workspaceId) {
        throw new HttpError(404, 'Dispatch not found')
      }
      if (dispatch.status !== 'reported') throw new HttpError(400, 'Dispatch has no report')
      const artifact = dispatch.artifacts[index]
      if (typeof artifact !== 'string') throw new HttpError(404, 'Artifact not found')
      sendJson(response, 200, await readDispatchArtifact(workspace.path, artifact))
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const dispatchId = getRequiredParam(response, params, 'dispatchId', 'Dispatch id is required')
      if (!workspaceId || !dispatchId) return
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }
      const dispatch = store.getDispatch(workspaceId, dispatchId)
      if (!dispatch) {
        sendJson(response, 404, { error: 'Dispatch not found' })
        return
      }
      sendJson(response, 200, serializeDispatchRecord(dispatch))
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/messages',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const dispatchId = getRequiredParam(response, params, 'dispatchId', 'Dispatch id is required')
      if (!workspaceId || !dispatchId) return
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('scope') === 'collaboration') {
        const cursorNames = ['after_message_id', 'before_message_id', 'around_message_id']
        if (cursorNames.flatMap((name) => url.searchParams.getAll(name)).length > 1) {
          sendJson(response, 400, { error: 'Message cursors are mutually exclusive' })
          return
        }
        const collaboration = store.getDispatchCollaboration(workspaceId, dispatchId)
        const history = store.listCollaborationMessageHistory(workspaceId, dispatchId, {
          ...(url.searchParams.has('after_message_id')
            ? { afterMessageId: url.searchParams.get('after_message_id') ?? '' }
            : {}),
          ...(url.searchParams.has('before_message_id')
            ? { beforeMessageId: url.searchParams.get('before_message_id') ?? '' }
            : {}),
          ...(url.searchParams.has('around_message_id')
            ? { aroundMessageId: url.searchParams.get('around_message_id') ?? '' }
            : {}),
        })
        sendJson(response, 200, {
          root_dispatch_id: collaboration.rootDispatchId,
          related_dispatches: collaboration.relatedDispatches.map((dispatch) => ({
            id: dispatch.id,
            parent_dispatch_id: dispatch.parentDispatchId,
            root_dispatch_id: dispatch.rootDispatchId,
            to_agent_id: dispatch.toAgentId,
            owner_name: dispatch.ownerName,
            state: dispatch.state,
            text: dispatch.text,
          })),
          messages: history.messages.map(serializeDispatchMessage),
          previous_before_message_id: history.previousBeforeMessageId,
          next_after_message_id: history.nextAfterMessageId,
        })
        return
      }

      const afterSeq = readBoundedInt(
        response,
        url.searchParams.get('after_seq'),
        'after_seq',
        0,
        Number.MAX_SAFE_INTEGER
      )
      if (afterSeq === null) return
      const messages = store.listDispatchMessageHistory(
        workspaceId,
        dispatchId,
        afterSeq,
        MAX_DISPATCH_LIMIT + 1
      )
      const page = messages.slice(0, MAX_DISPATCH_LIMIT)
      sendJson(response, 200, {
        messages: page.map(serializeDispatchMessage),
        next_after_seq: messages.length > page.length ? page.at(-1)?.sequence : null,
      })
    }
  ),
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

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.has('status')) {
        sendJson(response, 400, { error: 'Use state instead of status for dispatch filtering' })
        return
      }
      const state = url.searchParams.get('state')
      if (state !== null && !isDispatchStatus(state)) {
        sendJson(response, 400, {
          error: 'state must be queued, submitted, reported, or cancelled',
        })
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
      const hasReportedSince = url.searchParams.has('reported_since')
      if (hasReportedSince && state !== 'reported') {
        sendJson(response, 400, { error: 'reported_since requires state=reported' })
        return
      }
      const reportedSince = hasReportedSince
        ? readBoundedInt(
            response,
            url.searchParams.get('reported_since'),
            'reported_since',
            0,
            Number.MAX_SAFE_INTEGER
          )
        : undefined
      if (reportedSince === null) return
      response.setHeader('x-hive-snapshot-ms', String(Date.now()))

      const options = {
        limit,
        offset,
        ...(state ? { status: state } : {}),
        ...(reportedSince !== undefined ? { reportedSince } : {}),
      }
      sendJson(
        response,
        200,
        store.listDispatches(workspaceId, options).map(serializeDispatchRecord)
      )
    }
  ),
]
