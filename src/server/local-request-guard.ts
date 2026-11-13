import type { IncomingMessage } from 'node:http'

import { ForbiddenError } from './http-errors.js'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])
const LOCAL_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1'])

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const normalizeHostname = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase()

const isLocalHostname = (hostname: string) => LOCAL_HOSTNAMES.has(normalizeHostname(hostname))

const normalizeRemoteAddress = (address: string) =>
  normalizeHostname(address).replace(/^::ffff:/, '')

const isLocalRemoteAddress = (address: string) =>
  LOCAL_REMOTE_ADDRESSES.has(normalizeRemoteAddress(address))

const parseLocalAuthority = (authority: string): URL | null => {
  try {
    const url = new URL(`http://${authority}`)
    if (
      !isLocalHostname(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null
    return url
  } catch {
    return null
  }
}

export const getLocalRequestRejection = (request: IncomingMessage): string | null => {
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress && !isLocalRemoteAddress(remoteAddress)) return 'non-local remote address'

  const host = firstHeader(request.headers.host)
  const authority = host ? parseLocalAuthority(host) : null
  if (!authority) return host ? 'non-local Host header' : 'missing Host header'
  const boundPort = request.socket.localPort
  const configuredPort = process.env.HIVE_WEB_PORT
  const devPort =
    configuredPort && /^\d+$/.test(configuredPort) && Number(configuredPort) <= 65535
      ? Number(configuredPort)
      : undefined
  const hostPort = Number(authority.port || 80)
  if (hostPort !== boundPort && hostPort !== devPort) return 'invalid Host port'

  const origin = firstHeader(request.headers.origin)
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (!isLocalHostname(parsed.hostname)) return 'non-local Origin header'
      const configuredDevOrigin =
        devPort !== undefined &&
        isLocalHostname(parsed.hostname) &&
        Number(parsed.port || 80) === devPort
      if (
        parsed.protocol !== 'http:' ||
        origin !== parsed.origin ||
        (parsed.origin !== authority.origin && !configuredDevOrigin)
      )
        return 'invalid Origin header'
    } catch {
      return 'invalid Origin header'
    }
  }
  return null
}

export const assertLocalRequest = (request: IncomingMessage) => {
  const reason = getLocalRequestRejection(request)
  if (reason) throw new ForbiddenError(`Local runtime rejected ${reason}`)
}
