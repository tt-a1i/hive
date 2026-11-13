import type { IncomingMessage } from 'node:http'

import { ForbiddenError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store.js'

export const readCookie = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) {
    return undefined
  }

  for (const part of cookieHeader.split(';')) {
    const entry = part.trim()
    const separator = entry.indexOf('=')
    if (separator >= 0 && entry.slice(0, separator) === name) {
      return entry.slice(separator + 1)
    }
  }

  return undefined
}

export const requireUiTokenFromRequest = (
  request: IncomingMessage,
  validateUiToken: RuntimeStore['validateUiToken'],
  authorizeTunnel?: RuntimeStore['authorizeRemoteTunnelRequest']
) => {
  // Tunnel-originated requests carry the per-boot secret and short-circuit here
  // (invariant 2). A request with no secret header — every browser, every
  // existing test — gets authorizeTunnel === false and falls straight to the
  // cookie path, so cookie behavior is byte-identical (invariant 4).
  if (authorizeTunnel?.(request)) return
  const cookieHeader = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join('; ')
    : request.headers.cookie
  const token = readCookie(cookieHeader, 'hive_ui_token')
  if (!validateUiToken(token)) {
    throw new ForbiddenError('UI endpoint requires valid UI token')
  }
}
