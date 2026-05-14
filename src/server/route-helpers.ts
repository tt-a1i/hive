import type { IncomingMessage, ServerResponse } from 'node:http'

import { PayloadTooLargeError } from './http-errors.js'
import type { RouteDefinition } from './route-types.js'

const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024

export const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export const readJsonBody = async <T>(
  request: IncomingMessage,
  options: { limitBytes?: number } = {}
): Promise<T> => {
  const limitBytes = options.limitBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES
  const rawContentLength = request.headers['content-length']
  const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
  if (contentLength && Number(contentLength) > limitBytes) {
    throw new PayloadTooLargeError('Request body too large')
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.byteLength
    if (totalBytes > limitBytes) {
      throw new PayloadTooLargeError('Request body too large')
    }
    chunks.push(buffer)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export const getRequiredParam = (
  response: ServerResponse,
  params: Record<string, string>,
  key: string,
  error: string
) => {
  const value = params[key]
  if (value) {
    return value
  }

  sendJson(response, 400, { error })
  return null
}

export const route = (
  method: string,
  path: string,
  handler: RouteDefinition['handler']
): RouteDefinition => ({
  method,
  path,
  handler,
})

export const matchPath = (pattern: string, pathname: string) => {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)

  if (patternParts.length !== pathParts.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (const [index, patternPart] of patternParts.entries()) {
    const pathPart = pathParts[index]
    if (!pathPart) {
      return null
    }

    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart)
      continue
    }

    if (patternPart !== pathPart) {
      return null
    }
  }

  return params
}
