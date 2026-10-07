import type { IncomingMessage } from 'node:http'

import { BadRequestError, HttpError, PayloadTooLargeError } from './http-errors.js'
import { HIVE_REMOTE_DEVICE_HEADER } from './remote-loopback-auth.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import {
  WORKSPACE_UPLOAD_JSON_BODY_LIMIT_BYTES,
  WORKSPACE_UPLOAD_MAX_BYTES,
} from './upload-limits.js'
import { truncateUploadFilename, type WorkspaceUploadRecord } from './workspace-upload-store.js'

interface WorkspaceUploadBody {
  data?: unknown
  filename?: unknown
  mime_type?: unknown
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_UPLOAD_LIST_LIMIT = 100
// Bounds the multi-pass sanitizer cost: a body-limit-sized filename string
// would otherwise burn seconds of CPU before the final 180-char truncation.
const MAX_FILENAME_INPUT_LENGTH = 1024
const UPLOAD_LIMIT_LABEL = `${WORKSPACE_UPLOAD_MAX_BYTES / (1024 * 1024)}MB`

const assertWorkspaceExists = (store: RuntimeStore, workspaceId: string): void => {
  if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
    throw new HttpError(404, 'Workspace not found')
  }
}

const readUploadBody = async (request: IncomingMessage): Promise<WorkspaceUploadBody> => {
  try {
    return await readJsonBody<WorkspaceUploadBody>(request, {
      limitBytes: WORKSPACE_UPLOAD_JSON_BODY_LIMIT_BYTES,
    })
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BadRequestError('Request body must be valid JSON')
    }
    throw error
  }
}

const decodeUploadData = (value: unknown): Buffer => {
  if (typeof value !== 'string') {
    throw new BadRequestError('data must be a base64 string')
  }
  const data = value.trim()
  if (data.length === 0) return Buffer.alloc(0)
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new BadRequestError('data must be valid base64')
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const decodedBytes = (data.length / 4) * 3 - padding
  if (decodedBytes > WORKSPACE_UPLOAD_MAX_BYTES) {
    throw new PayloadTooLargeError(`Upload exceeds the ${UPLOAD_LIMIT_LABEL} limit`)
  }
  const buffer = Buffer.from(data, 'base64')
  if (buffer.byteLength !== decodedBytes) {
    throw new BadRequestError('data must be valid base64')
  }
  return buffer
}

const readFilename = (value: unknown): string => {
  if (value === undefined || value === null) return 'upload'
  if (typeof value !== 'string') throw new BadRequestError('filename must be a string')
  return truncateUploadFilename(value, MAX_FILENAME_INPUT_LENGTH)
}

const readMimeType = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new BadRequestError('mime_type must be a string')
  return value
}

const readRemoteDeviceId = (request: IncomingMessage, tunnelRequest: boolean): string | null => {
  if (!tunnelRequest) return null
  const raw = request.headers[HIVE_REMOTE_DEVICE_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128 || /[\r\n]/.test(trimmed)) return null
  return trimmed
}

const serializeUpload = (record: WorkspaceUploadRecord) => ({
  created_at: record.createdAt,
  id: record.id,
  mime_type: record.mimeType,
  original_name: record.originalName,
  size_bytes: record.sizeBytes,
  url: `/api/workspaces/${encodeURIComponent(record.workspaceId)}/uploads/${encodeURIComponent(record.id)}`,
  workspace_id: record.workspaceId,
})

const readListLimit = (request: IncomingMessage): number | undefined => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const raw = url.searchParams.get('limit')
  if (raw === null) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new BadRequestError('limit must be a non-negative integer')
  }
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_UPLOAD_LIST_LIMIT) {
    throw new BadRequestError(`limit must be between 1 and ${MAX_UPLOAD_LIST_LIMIT}`)
  }
  return limit
}

const encodeDispositionValue = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

const contentDispositionFor = (filename: string): string => {
  const fallback =
    filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/[\\"]/g, '_')
      .trim()
      .slice(0, 120) || 'upload'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeDispositionValue(filename)}`
}

export const workspaceUploadRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces/:workspaceId/uploads', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    assertWorkspaceExists(store, workspaceId)
    sendJson(
      response,
      200,
      store.listWorkspaceUploads(workspaceId, readListLimit(request)).map(serializeUpload)
    )
  }),

  route(
    'POST',
    '/api/workspaces/:workspaceId/uploads',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const tunnelRequest = store.authorizeRemoteTunnelRequest(request)
      requireUiTokenFromRequest(request, store.validateUiToken, () => tunnelRequest)
      assertWorkspaceExists(store, workspaceId)

      const body = await readUploadBody(request)
      const record = await store.saveWorkspaceUpload({
        data: decodeUploadData(body.data),
        mimeType: readMimeType(body.mime_type),
        originalName: readFilename(body.filename),
        remoteDeviceId: readRemoteDeviceId(request, tunnelRequest),
        workspaceId,
      })
      sendJson(response, 201, serializeUpload(record))
    }
  ),

  route(
    'GET',
    '/api/workspaces/:workspaceId/uploads/:uploadId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and upload id are required'
      )
      const uploadId = getRequiredParam(
        response,
        params,
        'uploadId',
        'Workspace id and upload id are required'
      )
      if (!workspaceId || !uploadId) return

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      assertWorkspaceExists(store, workspaceId)
      const upload = await store.readWorkspaceUpload(workspaceId, uploadId)
      if (!upload) {
        throw new HttpError(404, 'Upload not found')
      }

      response.statusCode = 200
      response.setHeader('content-type', upload.record.mimeType)
      response.setHeader('content-length', String(upload.data.byteLength))
      response.setHeader('content-disposition', contentDispositionFor(upload.record.originalName))
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('cache-control', 'private, max-age=0, must-revalidate')
      response.end(upload.data)
    }
  ),
]
