// Per-boot internal-secret header plumbing for the loopback bridge (invariant 2).
//
// The secret VALUE lives in UiAuth (the single token authority) — it is
// generated at boot, held only in-process, NEVER persisted, NEVER logged. This
// file holds only the wire-header names and the request/response header
// helpers the bridge uses. A 127.0.0.1 request carrying the live secret is
// authorized as tunnel-originated; absent/forged secret => normal UI-token
// treatment (rejected). This is the ONLY escalation to tunnel authority, and it
// is unforgeable from outside the runtime process.

// Tunnel-originated loopback requests carry these. They are also audit-tagging:
// x-hive-remote-device identifies the paired device for the audit trail. Both
// are stripped from any client-supplied copy before we stamp our own, so a
// phone can neither spoof the device tag nor smuggle a guessed secret.
export const HIVE_REMOTE_SECRET_HEADER = 'x-hive-remote-secret'
export const HIVE_REMOTE_DEVICE_HEADER = 'x-hive-remote-device'

// VULN-LOOPBACK-1: the request side needs the same posture as the response side. The phone fully
// controls the Open meta header list, and Node's http client copies any header we hand it verbatim
// (it only synthesises Host when none is present). A strip-2 blocklist let a phone smuggle
// Host/Origin/Cookie/X-Forwarded-*/Content-Length/Transfer-Encoding onto the 127.0.0.1 request,
// contradicting this file's "a phone can neither spoof nor smuggle" invariant. So we DROP every
// header that doesn't belong on a tunnel-originated loopback request and only let through the few
// the local runtime actually reads.
//
// Dropped, by reason:
//   - the 2 tunnel headers (always — we re-stamp our own copy last so it wins)
//   - host / origin — would defeat the daemon's fail-closed local-request guard (self-DoS) and have
//     no business being phone-controlled
//   - cookie — the phone never holds hive_ui_token; a guessed cookie is inert but doesn't belong here
//   - content-length / transfer-encoding — the bridge frames the body itself; a phone-declared length
//     is a request-smuggling primitive
//   - all hop-by-hop headers (meaningless across the mux boundary)
//   - any x-forwarded-* (the daemon is the origin; a forged forwarded chain is never trusted)
const REQUEST_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const REQUEST_DROPPED_HEADERS = new Set([
  'host',
  'origin',
  'cookie',
  'content-length',
  HIVE_REMOTE_SECRET_HEADER,
  HIVE_REMOTE_DEVICE_HEADER,
])

export function isTunnelDroppedRequestHeader(name: string): boolean {
  const lk = name.toLowerCase()
  if (REQUEST_DROPPED_HEADERS.has(lk)) return true
  if (REQUEST_HOP_BY_HOP_HEADERS.has(lk)) return true
  if (lk.startsWith('x-forwarded-') || lk.startsWith('x-hive-')) return true
  return false
}

// Stamp the loopback request/upgrade headers for a tunnel-originated request:
// drop every smuggling-prone / tunnel-only header (isTunnelDroppedRequestHeader), then set ours.
// Accepts the M1 header list ([name, value] pairs, which keep order + duplicates) or a plain record
// — the bridge passes meta.http.headers (a list) directly.
export function stampLoopbackHeaders(
  headers: Array<[string, string]> | Record<string, string>,
  secret: string,
  deviceId: string
): Record<string, string> {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers)
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (isTunnelDroppedRequestHeader(k)) continue
    out[k] = v
  }
  out[HIVE_REMOTE_SECRET_HEADER] = secret
  out[HIVE_REMOTE_DEVICE_HEADER] = deviceId
  return out
}

// HARDEN (response-header policy, invariant alongside 1/2): the bridge seals the
// loopback HTTP response head (status + headers) back to the phone. Some /api
// responses carry headers meant only for the local browser/runtime boundary —
// most dangerously Set-Cookie (the master hive_ui_token), but also any internal
// x-hive-* header now or in the future. The bridge MUST strip these before
// encodeHttpHead for tunnel-originated responses, so no auth/identity header
// ever crosses the trust boundary onto a remote device.
//
// Strips: hop-by-hop headers (meaningless across the mux boundary), Set-Cookie
// (any casing), and any x-hive-* internal header. Header NAMES are matched
// case-insensitively against the response head's [name, value] pairs.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const AUTH_BEARING_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2'])

export function isTunnelStrippedResponseHeader(name: string): boolean {
  const lk = name.toLowerCase()
  if (HOP_BY_HOP_HEADERS.has(lk)) return true
  if (AUTH_BEARING_RESPONSE_HEADERS.has(lk)) return true
  // Any internal x-hive-* header is daemon<->local-boundary only; never relay it.
  if (lk.startsWith('x-hive-')) return true
  return false
}

export function sanitizeTunnelResponseHeaders(
  headers: Array<[string, string]>
): Array<[string, string]> {
  return headers.filter(([name]) => !isTunnelStrippedResponseHeader(name))
}
