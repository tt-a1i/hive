import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { HIVE_REMOTE_SECRET_HEADER } from './remote-loopback-auth.js'

export interface UiAuth {
  getToken: () => string
  validate: (token: string | undefined) => boolean
  // True iff the request carries the live per-boot tunnel secret (constant-time
  // compare). The secret is the ONLY escalation to tunnel authority; an absent
  // or wrong secret returns false so the caller falls through to normal UI-token
  // treatment (invariant 2).
  isTunnelRequest: (request: IncomingMessage) => boolean
  // The live secret — handed ONLY to the in-process tunnel (via RuntimeStore) so
  // it can stamp loopback request headers. Never returned to a route handler,
  // never persisted, never logged.
  getTunnelSecret: () => string
}

export const createUiAuth = (): UiAuth => {
  const token = randomUUID()
  // 32 bytes of CSPRNG entropy, fresh every boot. base64url so it travels as a
  // clean header value. Held only in this closure.
  const tunnelSecret = randomBytes(32).toString('base64url')
  const expected = Buffer.from(tunnelSecret)

  return {
    getToken() {
      return token
    },
    validate(input) {
      if (typeof input !== 'string') return false
      const actual = Buffer.from(input)
      const reference = Buffer.from(token)
      return actual.length === reference.length && timingSafeEqual(actual, reference)
    },
    isTunnelRequest(request) {
      const raw = request.headers[HIVE_REMOTE_SECRET_HEADER]
      const got = Array.isArray(raw) ? raw[0] : raw
      if (typeof got !== 'string' || got.length === 0) return false
      const candidate = Buffer.from(got)
      // length check first: timingSafeEqual throws on mismatched lengths, and a
      // length difference is not secret anyway.
      if (candidate.length !== expected.length) return false
      return timingSafeEqual(candidate, expected)
    },
    getTunnelSecret() {
      return tunnelSecret
    },
  }
}
