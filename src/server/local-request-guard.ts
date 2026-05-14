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

const isLocalAuthority = (authority: string) => {
  try {
    return isLocalHostname(new URL(`http://${authority}`).hostname)
  } catch {
    return false
  }
}

const isLocalOrigin = (origin: string) => {
  try {
    return isLocalHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

export const getLocalRequestRejection = (request: IncomingMessage): string | null => {
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress && !isLocalRemoteAddress(remoteAddress)) return 'non-local remote address'

  const host = firstHeader(request.headers.host)
  if (host && !isLocalAuthority(host)) return 'non-local Host header'

  const origin = firstHeader(request.headers.origin)
  if (origin && !isLocalOrigin(origin)) return 'non-local Origin header'

  return null
}

export const assertLocalRequest = (request: IncomingMessage) => {
  const reason = getLocalRequestRejection(request)
  if (reason) throw new ForbiddenError(`Local runtime rejected ${reason}`)
}
