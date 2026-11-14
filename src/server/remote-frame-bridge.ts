// The E2E/mux frame bridge — the trusted core of the remote tunnel.
//
// The tunnel controller (remote-tunnel.ts) only pumps opaque bytes between the gateway socket and
// this bridge. THIS file is where opaque phone frames become real loopback requests:
//
//   inbound frame  ->  split header||ciphertext  ->  resolve device (trial-open against candidates)
//                  ->  openNext (M1: AEAD integrity + seq replay guard)  ->  ONLY NOW trust the
//                      decoded header.kind + plaintext  ->  per-stream machine  ->  on Open, run the
//                      whitelist gate (classifyOpen) BEFORE any loopback socket  ->  bridge to
//                      127.0.0.1:<port> (stamped with the per-boot secret)  ->  seal the response back
//
// SECURITY INVARIANTS enforced here:
//   1. Whitelist: classifyOpen runs on the OPENED Open meta; a non-whitelisted/non-canonical path is
//      Reset(StreamRefused) + audited, NEVER a loopback request (the "not a general localhost proxy"
//      gate). /api/ui/session is hard-denied.
//   2. Per-boot secret: every loopback request/upgrade is stamped via stampLoopbackHeaders with the
//      injected loopbackSecret + the resolved deviceId; response heads are sanitized so Set-Cookie /
//      x-hive-* never cross back to the phone.
//   5. E2E integrity: a frame that fails to open (tamper/replay/unknown device) is dropped + audited,
//      NEVER bridged. deviceId is ONLY ever the result of a successful open — never a clear-text field.
//   6. Audit: this layer is the single collection point (http / ws_open / ws_input / reject).

import { request as httpRequest } from 'node:http'
import WebSocketClient from 'ws'
import { type BridgeRejectReason, classifyOpen } from '../shared/remote-bridge-routing.js'
import {
  type ConnectionKeys,
  createOpener,
  createSealer,
  type Direction,
  generateConnSalt as defaultGenerateConnSalt,
  deriveConnectionKeys,
  type FrameOpener,
  type FrameSealer,
  openNext,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  createFlowController,
  createStreamMachine,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  decodeOpenPayload,
  decodeWsMessage,
  encodeConnSalt,
  encodeHeader,
  encodeHttpBodyChunk,
  encodeHttpHead,
  encodeResetPayload,
  encodeWsMessage,
  type FlowController,
  FrameKind,
  HEADER_BYTES,
  type HttpResponseHead,
  isConnSaltPayload,
  ResetCode,
  type StreamMachine,
  type StreamMeta,
} from '../shared/remote-protocol.js'
import { wrapRelayRoute } from '../shared/remote-relay-route.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import {
  DAEMON_OPEN_DIRECTION,
  DAEMON_SEAL_DIRECTION,
  type DeviceSession,
  type DeviceSessionProvider,
} from './remote-device-session.js'
import { sanitizeTunnelResponseHeaders, stampLoopbackHeaders } from './remote-loopback-auth.js'

// ── loopback transport seam (real node:http / ws by default; stubbed in unit tests) ─────────────

const LOOPBACK_WS_PENDING_BYTES_LIMIT = 256 * 1024

/** A loopback HTTP request in flight. The bridge feeds it body chunks then end()s it. */
export interface LoopbackHttpRequest {
  onData(chunk: Uint8Array): void
  onEnd(): void
  abort(): void
}

export interface LoopbackHttpHandlers {
  onHead(head: HttpResponseHead): void
  onBody(chunk: Uint8Array): void
  onEnd(): void
  onError(err: Error): void
}

/** A loopback WS connection in flight. */
export interface LoopbackWsConnection {
  onData(data: Uint8Array, isText: boolean): void
  onClose(): void
  abort(): void
}

export interface LoopbackWsHandlers {
  onOpen(): void
  onMessage(data: Uint8Array, isText: boolean): void
  onClose(): void
  onError(err: Error): void
}

export interface LoopbackTransports {
  openHttp(
    args: { port: number; method: string; path: string; headers: Record<string, string> },
    handlers: LoopbackHttpHandlers
  ): LoopbackHttpRequest
  openWs(
    args: { port: number; path: string; headers: Record<string, string> },
    handlers: LoopbackWsHandlers
  ): LoopbackWsConnection
}

const realLoopbackTransports: LoopbackTransports = {
  openHttp(args, handlers) {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: args.port,
        method: args.method,
        path: args.path,
        headers: args.headers,
      },
      (res) => {
        const headerList: Array<[string, string]> = []
        const raw = res.rawHeaders
        for (let i = 0; i + 1 < raw.length; i += 2) {
          headerList.push([raw[i] as string, raw[i + 1] as string])
        }
        handlers.onHead({ status: res.statusCode ?? 0, headers: headerList })
        res.on('data', (chunk: Buffer) => handlers.onBody(new Uint8Array(chunk)))
        res.on('end', () => handlers.onEnd())
        res.on('error', (err) => handlers.onError(err))
      }
    )
    req.on('error', (err) => handlers.onError(err))
    return {
      onData: (chunk) => {
        req.write(Buffer.from(chunk))
      },
      onEnd: () => {
        req.end()
      },
      abort: () => {
        req.destroy()
      },
    }
  },
  openWs(args, handlers) {
    const ws = new WebSocketClient(`ws://127.0.0.1:${args.port}${args.path}`, {
      headers: args.headers,
    })
    let closed = false
    let queuedBytes = 0
    const queued: Array<{ data: Buffer; isText: boolean }> = []
    const sendNow = (data: Buffer, isText: boolean) => {
      ws.send(data, { binary: !isText }, (err) => {
        if (err) handlers.onError(err)
      })
    }
    const flushQueued = () => {
      for (const item of queued.splice(0)) {
        if (closed || ws.readyState !== WebSocketClient.OPEN) break
        sendNow(item.data, item.isText)
      }
      queuedBytes = 0
    }
    ws.binaryType = 'arraybuffer'
    ws.on('open', () => {
      handlers.onOpen()
      flushQueued()
    })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      handlers.onMessage(new Uint8Array(buf), !isBinary)
    })
    ws.on('close', () => {
      closed = true
      queued.length = 0
      queuedBytes = 0
      handlers.onClose()
    })
    ws.on('error', (err) => handlers.onError(err))
    return {
      onData: (data, isText) => {
        const buf = Buffer.from(data)
        if (ws.readyState === WebSocketClient.OPEN) {
          sendNow(buf, isText)
          return
        }
        if (closed || ws.readyState !== WebSocketClient.CONNECTING) return
        queuedBytes += buf.byteLength
        if (queuedBytes > LOOPBACK_WS_PENDING_BYTES_LIMIT) {
          closed = true
          queued.length = 0
          queuedBytes = 0
          handlers.onError(new Error('loopback websocket pending buffer exceeded'))
          try {
            ws.terminate()
          } catch {
            // already gone
          }
          return
        }
        queued.push({ data: buf, isText })
      },
      onClose: () => {
        closed = true
        queued.length = 0
        queuedBytes = 0
        try {
          ws.close()
        } catch {
          // already gone
        }
      },
      abort: () => {
        closed = true
        queued.length = 0
        queuedBytes = 0
        try {
          ws.terminate()
        } catch {
          // already gone
        }
      },
    }
  },
}

// ── bridge ───────────────────────────────────────────────────────────────────────────────────────

export interface FrameBridgeContext {
  loopbackPort: number
  loopbackSecret: string
  deviceSessions: DeviceSessionProvider
  audit: RemoteAuditStore
  /**
   * The daemon's own id (config.getDaemonId()). M6.1: it is bound into the per-connection HKDF info,
   * so it MUST be the SAME value the phone put in its HandshakeIds.daemonId — a mismatch diverges the
   * info strings and EVERY Hello fails to open (total outage). Sourced at socket-open time in
   * remote-tunnel.ts (guarded non-null; the tunnel can't be online without it).
   */
  daemonId: string
  /**
   * Injected loopback transports. Production omits this and gets the real node:http / ws clients;
   * unit tests pass a stub so a single bridged request is observable without real I/O. Carried on
   * the context (not a separate arg) so the tunnel's `createBridge: (ctx) => createFrameBridge(ctx)`
   * wiring is untouched and a test can simply add the field.
   */
  loopbackTransports?: LoopbackTransports
  /**
   * Seam: the per-connection daemon salt source. Defaults to the crypto export; a test injects a
   * deterministic-but-distinct generator so it can recompute the connKey + nonce. NOT a mock — the
   * real HKDF still runs over whatever bytes this returns.
   */
  generateConnSalt?: () => Uint8Array
  /**
   * Observation hook (NOT a mock): fires for every daemon->phone seal with the REAL AEAD key + REAL
   * 12-byte header. Lets the no-(key,nonce)-reuse + no-downgrade invariants be mutation-tested by a
   * recorder; the production sealNext still runs unchanged.
   */
  onSeal?: (rec: { key: Uint8Array; direction: Direction; headerBytes: Uint8Array }) => void
}

export interface FrameBridge {
  attachSocket(send: (frame: Uint8Array) => void): void
  onInbound(frame: ArrayBuffer | Uint8Array): void
  /**
   * Tear down every in-flight stream. `keepSink` distinguishes the two callers:
   *   - socket teardown (onSocketDown / revokeAndStop / close): the outbound socket is gone, so we
   *     also null the sink (keepSink omitted/false) and audit a session_close.
   *   - gateway 'peer-offline' control: the daemon socket STAYS OPEN (the gateway just told us the
   *     phone dropped its streams). We reset the in-flight streams but MUST keep `send` live so the
   *     phone can re-establish streams on the same socket after 'peer-online'. Audited as a
   *     stream-reset, not a session_close.
   */
  resetAllStreams(reason: string, opts?: { keepSink?: boolean }): void
  /**
   * Close ONE device's in-flight streams (M4 revoke closed loop). Unlike resetAllStreams this leaves
   * other devices + the outbound sink untouched, so revoking device A never tears down device B. The
   * per-device opener/sealer is dropped too, so a re-pair of the same id starts from clean crypto
   * state. The persistent provider's revoke (the security-load-bearing half) already makes NEW frames
   * fail with no_session; this is the best-effort liveness half that kills an ALREADY-open stream now.
   */
  closeDevice(deviceId: string, reason: string): void
}

interface StreamBridge {
  deviceId: string
  transport: 'http' | 'ws'
  path: string
  machine: StreamMachine
  // M1 receiver-side flow: ack inbound phone->daemon bytes so the phone keeps streaming.
  recvFlow: FlowController
  // M6 sender-side flow (VULN-RELIABILITY-1): the daemon->phone credit window. Every daemon->phone
  // Data byte we seal is trySend()'d; the phone's cumulative Ack frame applyAck()s it. When the window
  // is exhausted (a slow/stalled phone never acks) we stop propagating the loopback source forward so
  // daemon memory can't grow unbounded — for the terminal io stream that means withholding the local
  // self-ack so the server's UNACKED_HIGH_WATER pauses the PTY (end-to-end backpressure).
  sendFlow: FlowController
  http?: LoopbackHttpRequest
  ws?: LoopbackWsConnection
  // For a terminal io stream: a companion loopback CONTROL socket the bridge opens itself, so it can
  // emit output_ack as it drains PTY output. Without it the server's UNACKED_HIGH_WATER fills and
  // pauseTerminalRun deadlocks the PTY (the io socket has no output_ack handler). See HARDEN major:
  // the tunnel is the loopback io consumer and drains immediately, so it self-acks locally rather
  // than waiting on a phone-side control output_ack that may never come.
  ioAckControl?: LoopbackWsConnection
  // Bytes drained off the loopback io socket that we have NOT yet self-acked to the server, because
  // the daemon->phone window is exhausted. Released to the local control socket as the phone acks,
  // so the PTY pauses while the phone is behind and resumes once it catches up.
  ioPendingSelfAck: number
  closed: boolean
}

interface DeviceState {
  session: DeviceSession // .keys are ROOTS (never an AEAD key directly)
  // Per-connection AEAD keys derived from this device's root + the bilateral connection salts. The
  // sealer/opener operate ONLY under these — session.keys never reaches sealNext/openNext.
  connKeys: ConnectionKeys
  // The phoneConnSalt these connKeys were FROZEN under (at bind time). Kept so a second phone's salt
  // can't silently re-key an already-bound device (HARDEN major 4: connKeys are per-device, not a
  // single bridge-wide value), and so a genuine re-handshake (a NEW salt for THIS device) rebuilds it.
  phoneConnSalt: Uint8Array
  opener: FrameOpener
  sealer: FrameSealer
}

const te = new TextEncoder()

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// /ws/terminal/<runId>/io -> /ws/terminal/<runId>/control (same clientId space, default 'legacy').
const TERMINAL_IO_RE = /^\/ws\/terminal\/([^/?]+)\/io$/
const terminalControlPathFor = (ioPath: string): string | null => {
  const m = TERMINAL_IO_RE.exec(ioPath)
  if (!m) return null
  return `/ws/terminal/${m[1]}/control`
}

// Reattach the WS query (clientId/cols/rows) — which rode the separate StreamMeta.ws.query field —
// onto a bare loopback path. Each key/value is percent-encoded so it lands as a normal searchParam.
const appendQuery = (path: string, query: [string, string][] | undefined): string => {
  if (!query || query.length === 0) return path
  const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${path}?${qs}`
}

export const createFrameBridge = (ctx: FrameBridgeContext): FrameBridge => {
  const transports = ctx.loopbackTransports ?? realLoopbackTransports
  const { audit } = ctx
  const genConnSalt = ctx.generateConnSalt ?? defaultGenerateConnSalt

  let send: ((frame: Uint8Array) => void) | null = null

  // Per-CONNECTION (per-socket) bilateral salts (M6.1). The daemon draws its salt at attachSocket; each
  // phone's arrives as an UNSEALED ConnSalt on CONN_SALT_STREAM_ID. Both feed deriveConnectionKeys so
  // every (re)connect / page reload gets fresh AEAD keys over the SAME persisted root — no nonce reuse.
  let daemonConnSalt: Uint8Array | null = null
  // The relay multiplexes N phones over one daemon socket, and their ConnSalts can interleave with
  // their sealed Hellos. The daemon can't know which device owns an anonymous ConnSalt until that
  // device's Hello trial-opens — so it keeps a small ring of recently-seen phone salts and binds a
  // device by the (candidate root × pending salt) pair that opens its Hello. Once bound, the device's
  // connKeys are FROZEN (HARDEN major 4) — a later phone's salt never re-keys an already-bound device.
  const pendingPhoneSalts: Uint8Array[] = []
  const MAX_PENDING_SALTS = 16

  const rememberPhoneSalt = (salt: Uint8Array): void => {
    // Drop a byte-identical duplicate (a broadcast re-emit), keep most-recent-first, bound the ring.
    const i = pendingPhoneSalts.findIndex((s) => bytesEqual(s, salt))
    if (i >= 0) pendingPhoneSalts.splice(i, 1)
    pendingPhoneSalts.unshift(salt)
    if (pendingPhoneSalts.length > MAX_PENDING_SALTS) pendingPhoneSalts.length = MAX_PENDING_SALTS
  }

  // Per-device crypto state (connKeys/opener/sealer). deviceId is only ever set after a successful open.
  const devices = new Map<string, DeviceState>()
  // Salts this daemon socket has already accepted for a device and then replaced. The daemon salt is
  // fixed for the socket, so accepting an old phone salt again would recreate an old connKey and
  // rewind seq. Clear this on every daemon socket attach, where the daemon salt rotates.
  const retiredPhoneSalts = new Map<string, Uint8Array[]>()
  // The demux table is keyed by (deviceId, streamId) — NOT streamId alone — so two devices reusing
  // the same odd streamId never collide (M4 multi-device prerequisite, HARDEN minor 4c).
  const streams = new Map<string, StreamBridge>()
  // streamId -> deviceId binding, learned on the first successfully-opened frame for a stream.
  const streamOwner = new Map<number, string>()

  const streamKey = (deviceId: string, streamId: number): string => `${deviceId}\0${streamId}`

  // Derive a candidate DeviceState for (session, phoneConnSalt) WITHOUT caching it. Used to trial-open
  // an unbound frame against each (root × pending salt) pair; only the pair that opens gets committed
  // into `devices` (freezing the device's connKeys for the rest of the connection).
  const deriveDeviceState = (
    session: DeviceSession,
    phoneConnSalt: Uint8Array
  ): DeviceState | null => {
    if (!daemonConnSalt) return null
    const connKeys = deriveConnectionKeys({
      rootD2p: session.keys.d2p,
      rootP2d: session.keys.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids: {
        daemonId: ctx.daemonId,
        deviceId: session.deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      },
    })
    return {
      session,
      connKeys,
      phoneConnSalt,
      opener: createOpener(DAEMON_OPEN_DIRECTION),
      sealer: createSealer(DAEMON_SEAL_DIRECTION),
    }
  }

  // Emit the UNSEALED daemon ConnSalt on CONN_SALT_STREAM_ID so the phone can derive the connKeys.
  const emitDaemonSalt = (): void => {
    if (!send || !daemonConnSalt) return
    const header = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: CONN_SALT_STREAM_ID,
      seq: 0,
    })
    const body = encodeConnSalt({ role: 'daemon', salt: daemonConnSalt })
    const frame = new Uint8Array(header.length + body.length)
    frame.set(header, 0)
    frame.set(body, header.length)
    send(frame)
  }

  // Seal an outbound daemon->phone frame for a device's stream and push it onto the socket.
  const sendFrame = (
    st: DeviceState,
    kind: FrameKind,
    streamId: number,
    payload: Uint8Array,
    flags = 0
  ): void => {
    if (!send) return
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind,
      flags,
      streamId,
      seq: st.sealer.nextSeq,
    })
    // Observe the REAL connKey + header (no-reuse / no-downgrade invariant, mutation-tested). NOT a
    // mock — sealNext still runs on the same key below; the root NEVER reaches this call.
    ctx.onSeal?.({
      key: st.connKeys[DAEMON_SEAL_DIRECTION],
      direction: DAEMON_SEAL_DIRECTION,
      headerBytes,
    })
    const { ciphertext } = sealNext(st.sealer, {
      key: st.connKeys[DAEMON_SEAL_DIRECTION],
      streamId,
      headerBytes,
      payload,
    })
    const out = new Uint8Array(headerBytes.length + ciphertext.length)
    out.set(headerBytes, 0)
    out.set(ciphertext, headerBytes.length)
    // Gateway-hop routing prefix: RelayDO delivers this frame to this device only.
    // ConnSalt stays unprefixed (broadcast) via emitDaemonSalt.
    send(wrapRelayRoute(st.session.deviceId, out))
  }

  const sendReset = (st: DeviceState, streamId: number, code: ResetCode): void => {
    sendFrame(st, FrameKind.Reset, streamId, encodeResetPayload(code))
  }

  // Emit a terminal output_ack on the companion control socket for `bytes` drained off the io socket.
  const emitIoSelfAck = (sb: StreamBridge, bytes: number): void => {
    if (!sb.ioAckControl || bytes <= 0) return
    sb.ioAckControl.onData(te.encode(JSON.stringify({ type: 'output_ack', bytes })), true)
  }

  // Self-ack the loopback io socket for bytes we just drained, but ONLY while the daemon->phone window
  // could absorb them. `fitWindow` is the trySend result for this chunk: when it fit, the bytes are
  // within the unacked budget so we ack them locally; when it did NOT fit (the phone is behind / never
  // acks) we withhold the self-ack so the server's UNACKED_HIGH_WATER pauses the PTY — that local pause
  // is what bounds daemon memory. Withheld bytes are released once a phone Ack frees the window.
  const releaseIoSelfAck = (sb: StreamBridge, justDrained: number, fitWindow: boolean): void => {
    if (!sb.ioAckControl) return
    if (!fitWindow) {
      sb.ioPendingSelfAck += justDrained
      return
    }
    // Window had room: ack the bytes we just drained plus any we'd withheld earlier.
    const release = justDrained + sb.ioPendingSelfAck
    sb.ioPendingSelfAck = 0
    emitIoSelfAck(sb, release)
  }

  const tearDownStream = (key: string, reason: 'reset' | 'end'): void => {
    const sb = streams.get(key)
    if (!sb) return
    sb.closed = true
    if (sb.http) sb.http.abort()
    if (sb.ws) {
      if (reason === 'reset') sb.ws.abort()
      else sb.ws.onClose()
    }
    if (sb.ioAckControl) {
      if (reason === 'reset') sb.ioAckControl.abort()
      else sb.ioAckControl.onClose()
    }
    streams.delete(key)
    streamOwner.delete(extractStreamId(key))
  }

  const extractStreamId = (key: string): number => Number(key.split('\0')[1])

  const retirePhoneSalt = (deviceId: string, salt: Uint8Array): void => {
    const retired = retiredPhoneSalts.get(deviceId) ?? []
    if (!retired.some((s) => bytesEqual(s, salt))) retired.unshift(Uint8Array.from(salt))
    if (retired.length > MAX_PENDING_SALTS) retired.length = MAX_PENDING_SALTS
    retiredPhoneSalts.set(deviceId, retired)
  }

  const hasRetiredPhoneSalt = (deviceId: string, salt: Uint8Array): boolean =>
    retiredPhoneSalts.get(deviceId)?.some((s) => bytesEqual(s, salt)) ?? false

  const tearDownDeviceStreams = (deviceId: string): void => {
    for (const key of [...streams.keys()]) {
      const sb = streams.get(key)
      if (!sb || sb.deviceId !== deviceId) continue
      tearDownStream(key, 'reset')
    }
  }

  // Resolve the device for a frame on `streamId`. Three tiers:
  //   1. Stream already bound → its owner's FROZEN connKeys.
  //   2. Any ALREADY-BOUND device (cached connKeys) — covers H-NET-4 (two devices share an odd id).
  //   3. UNBOUND: trial-open against each (candidate root × pending phone salt). The pair that opens
  //      identifies (device, this connection's salt); commit it into `devices`, freezing its connKeys.
  // Only the open authenticates — deviceId is never read from a clear-text field (invariant 5).
  const resolveAndOpen = (
    streamId: number,
    seq: number,
    headerBytes: Uint8Array,
    ciphertext: Uint8Array
  ): { device: DeviceState; plaintext: Uint8Array } | null => {
    const tryOpen = (st: DeviceState): Uint8Array | null => {
      try {
        return openNext(st.opener, {
          key: st.connKeys[DAEMON_OPEN_DIRECTION],
          streamId,
          headerBytes,
          ciphertext,
          seq,
        })
      } catch {
        return null
      }
    }

    const boundDeviceId = streamOwner.get(streamId)
    if (boundDeviceId !== undefined) {
      const st = devices.get(boundDeviceId)
      // H-NET-4: a frame that fails against the bound owner is likely a DIFFERENT device reusing the
      // same odd id — fall through to the cached/candidate scan instead of black-holing it. A genuine
      // tamper/replay still fails everywhere below and is dropped.
      if (st) {
        const pt = tryOpen(st)
        if (pt) return { device: st, plaintext: pt }
      }
    }

    // Tier 2: any other already-bound device (frozen connKeys). Never re-derives, so device A is never
    // desynced when device B handshakes on the same socket (HARDEN major 4).
    for (const st of devices.values()) {
      if (st.session.deviceId === boundDeviceId) continue
      const pt = tryOpen(st)
      if (pt) {
        if (streamId !== CHANNEL_STREAM_ID) streamOwner.set(streamId, st.session.deviceId)
        return { device: st, plaintext: pt }
      }
    }

    // Tier 3: UNBOUND — trial-open each candidate ROOT against each pending phone salt. The matching
    // (device, salt) pair commits + freezes. Requires both salts known (else no connKey can exist).
    if (!daemonConnSalt || pendingPhoneSalts.length === 0) return null
    for (const session of ctx.deviceSessions.candidates()) {
      const existing = devices.get(session.deviceId)
      for (const salt of pendingPhoneSalts) {
        if (existing && bytesEqual(existing.phoneConnSalt, salt)) continue
        if (hasRetiredPhoneSalt(session.deviceId, salt)) continue
        const st = deriveDeviceState(session, salt)
        if (!st) continue
        const pt = tryOpen(st)
        if (pt) {
          if (existing) {
            retirePhoneSalt(session.deviceId, existing.phoneConnSalt)
            tearDownDeviceStreams(session.deviceId)
          }
          devices.set(session.deviceId, st) // freeze this device's connKeys for the connection
          if (streamId !== CHANNEL_STREAM_ID) streamOwner.set(streamId, session.deviceId)
          return { device: st, plaintext: pt }
        }
      }
    }
    return null
  }

  // ── per-kind handling AFTER a successful open (the header is now trusted) ─────────────────────

  const onOpenFrame = (st: DeviceState, streamId: number, plaintext: Uint8Array): void => {
    const deviceId = st.session.deviceId
    let meta: StreamMeta
    try {
      meta = decodeOpenPayload(plaintext)
    } catch {
      sendReset(st, streamId, ResetCode.ProtocolError)
      audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: 'malformed_meta',
        deviceId,
      })
      return
    }

    const decision = classifyOpen(meta)
    if (!decision.ok) {
      sendReset(st, streamId, ResetCode.StreamRefused)
      audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: decision.reason satisfies BridgeRejectReason,
        endpoint: meta.http?.path ?? meta.ws?.path ?? null,
        deviceId,
      })
      return
    }

    const key = streamKey(deviceId, streamId)
    const machine = createStreamMachine()
    machine.onRecv(FrameKind.Open)
    const sb: StreamBridge = {
      deviceId,
      transport: decision.transport,
      path: decision.path,
      machine,
      recvFlow: createFlowController(),
      sendFlow: createFlowController(),
      ioPendingSelfAck: 0,
      closed: false,
    }
    streams.set(key, sb)

    // HTTP carries a header list in its meta; WS does not (the loopback upgrade only needs the
    // stamped tunnel headers). Either way we strip any phone-supplied tunnel-header copies.
    const headers = stampLoopbackHeaders(meta.http?.headers ?? [], ctx.loopbackSecret, deviceId)

    if (decision.transport === 'http') {
      try {
        sb.http = transports.openHttp(
          { port: ctx.loopbackPort, method: decision.method, path: decision.path, headers },
          {
            onHead: (head) => {
              if (sb.closed) return
              const safe: HttpResponseHead = {
                status: head.status,
                headers: sanitizeTunnelResponseHeaders(head.headers),
              }
              sendFrame(st, FrameKind.Data, streamId, encodeHttpHead(safe))
            },
            onBody: (chunk) => {
              if (sb.closed) return
              sendFrame(st, FrameKind.Data, streamId, encodeHttpBodyChunk(chunk))
            },
            onEnd: () => {
              if (sb.closed) return
              sb.closed = true
              sendFrame(st, FrameKind.End, streamId, new Uint8Array(0))
              audit.enqueue({ action: 'http', result: 'ok', endpoint: sb.path, deviceId })
              streams.delete(key)
              streamOwner.delete(streamId)
            },
            onError: () => {
              if (sb.closed) return
              sb.closed = true
              sendReset(st, streamId, ResetCode.InternalError)
              audit.enqueue({ action: 'http', result: 'error', endpoint: sb.path, deviceId })
              streams.delete(key)
              streamOwner.delete(streamId)
            },
          }
        )
      } catch {
        sendReset(st, streamId, ResetCode.InternalError)
        tearDownStream(key, 'reset')
      }
    } else {
      // The WS query (clientId/cols/rows) rode the separate decision.query field (classifyOpen keeps
      // the path bare). Reattach it onto the loopback URL so terminal-ws-server reads clientId/cols/
      // rows from url.searchParams exactly as a same-origin upgrade does.
      const loopbackWsPath = appendQuery(decision.path, decision.query)

      // Terminal io self-ack: open a companion loopback CONTROL socket so the bridge can emit
      // output_ack as it drains PTY output (HARDEN major). The companion shares the io stream's
      // clientId space (default 'legacy'), so its acks decrement the same viewer's UNACKED counter —
      // so it must carry the SAME query (the clientId) as the io socket.
      const controlPath = terminalControlPathFor(decision.path)
      if (controlPath) {
        sb.ioAckControl = transports.openWs(
          { port: ctx.loopbackPort, path: appendQuery(controlPath, decision.query), headers },
          {
            onOpen: () => {},
            // The control socket receives restore/exit/error frames; the bridge ignores them for
            // self-ack purposes (the phone's real control stream, if any, carries those separately).
            onMessage: () => {},
            onClose: () => {},
            onError: () => {},
          }
        )
      }

      sb.ws = transports.openWs(
        { port: ctx.loopbackPort, path: loopbackWsPath, headers },
        {
          onOpen: () => {
            audit.enqueue({ action: 'ws_open', result: 'ok', endpoint: sb.path, deviceId })
          },
          onMessage: (data, isText) => {
            if (sb.closed) return
            // The bytes are already in RAM (the loopback handed them to us); forward them now so the
            // phone gets every byte in order. The sender window doesn't gate the forward — it gates
            // the SELF-ACK, which is the real backpressure lever: withholding it leaves the bytes
            // unacked on the server so UNACKED_HIGH_WATER pauses the PTY (no more chunks arrive).
            const fit = sb.sendFlow.trySend(data.length).ok
            sendFrame(st, FrameKind.Data, streamId, encodeWsMessage(data, isText))
            // Self-ack the bytes we drained ONLY while the daemon->phone window could absorb them. When
            // the phone falls behind (never acks) the window stays exhausted, the self-ack is withheld
            // (accumulated in ioPendingSelfAck), and the local pause backstops daemon memory. A phone
            // Ack (onAckFrame -> applyAck) releases the withheld self-acks and resumes the PTY.
            releaseIoSelfAck(sb, data.length, fit)
          },
          onClose: () => {
            if (sb.closed) return
            sb.closed = true
            sb.ioAckControl?.onClose()
            sendFrame(st, FrameKind.End, streamId, new Uint8Array(0))
            streams.delete(key)
            streamOwner.delete(streamId)
          },
          onError: () => {
            if (sb.closed) return
            sb.closed = true
            sb.ioAckControl?.abort()
            sendReset(st, streamId, ResetCode.InternalError)
            streams.delete(key)
            streamOwner.delete(streamId)
          },
        }
      )
    }
  }

  const onDataFrame = (st: DeviceState, streamId: number, plaintext: Uint8Array): void => {
    const key = streamKey(st.session.deviceId, streamId)
    const sb = streams.get(key)
    if (!sb || sb.closed) return
    const recv = sb.machine.onRecv(FrameKind.Data)
    if (!recv.ok) {
      sendReset(st, streamId, recv.reset)
      tearDownStream(key, 'reset')
      return
    }
    // M1 receiver flow: ack consumed bytes so the phone can keep sending large bodies/pastes.
    const ack = sb.recvFlow.onConsume(plaintext.length)
    if (ack) {
      // Ack rides the channel as an Ack frame on this stream id (cumulative byte count).
      const payload = new Uint8Array(4)
      new DataView(payload.buffer).setUint32(0, ack.ackCumulative)
      sendFrame(st, FrameKind.Ack, streamId, payload)
    }

    if (sb.transport === 'http') {
      let chunk: ReturnType<typeof decodeHttpData>
      try {
        chunk = decodeHttpData(plaintext)
      } catch {
        sendReset(st, streamId, ResetCode.ProtocolError)
        tearDownStream(key, 'reset')
        return
      }
      if (chunk.kind === 'body') sb.http?.onData(chunk.data)
      // a 'head' on the request side is illegal; ignore.
    } else {
      let msg: ReturnType<typeof decodeWsMessage>
      try {
        msg = decodeWsMessage(plaintext)
      } catch {
        sendReset(st, streamId, ResetCode.ProtocolError)
        tearDownStream(key, 'reset')
        return
      }
      audit.enqueue({
        action: 'ws_input',
        result: 'ok',
        endpoint: sb.path,
        deviceId: st.session.deviceId,
        byteCount: msg.data.length,
        preview: msg.isText ? new TextDecoder().decode(msg.data) : null,
      })
      sb.ws?.onData(msg.data, msg.isText)
    }
  }

  const onEndFrame = (st: DeviceState, streamId: number): void => {
    const key = streamKey(st.session.deviceId, streamId)
    const sb = streams.get(key)
    if (!sb || sb.closed) return
    sb.machine.onRecv(FrameKind.End)
    // Phone finished its half (request body / outbound ws). Tell loopback the input is done.
    if (sb.transport === 'http') sb.http?.onEnd()
    else sb.ws?.onClose()
  }

  const onResetFrame = (st: DeviceState, streamId: number): void => {
    const key = streamKey(st.session.deviceId, streamId)
    tearDownStream(key, 'reset')
  }

  const onAckFrame = (st: DeviceState, streamId: number, plaintext: Uint8Array): void => {
    // M6 sender-window ack from the phone (VULN-RELIABILITY-1). The Ack payload is a 4-byte cumulative
    // byte count. applyAck advances the window; when it RESUMES (the phone caught up enough to free the
    // window) we release the self-acks we withheld so the server's terminal flow control un-pauses the
    // PTY. Without this the daemon either grows memory unbounded (no window) or deadlocks (a window
    // that never resumes).
    const sb = streams.get(streamKey(st.session.deviceId, streamId))
    if (!sb) return
    if (plaintext.length < 4) return
    const cumulative = new DataView(
      plaintext.buffer,
      plaintext.byteOffset,
      plaintext.byteLength
    ).getUint32(0)
    const { resumed } = sb.sendFlow.applyAck(cumulative)
    if (resumed && sb.ioPendingSelfAck > 0) {
      const release = sb.ioPendingSelfAck
      sb.ioPendingSelfAck = 0
      emitIoSelfAck(sb, release)
    }
  }

  const handleOpened = (
    st: DeviceState,
    header: ReturnType<typeof decodeHeader>,
    plaintext: Uint8Array
  ): void => {
    if (header.streamId === CHANNEL_STREAM_ID) {
      // Hello / channel control. Opening it bound the device; nothing else to bridge in M3.
      return
    }
    switch (header.kind) {
      case FrameKind.Open:
        onOpenFrame(st, header.streamId, plaintext)
        break
      case FrameKind.Data:
        onDataFrame(st, header.streamId, plaintext)
        break
      case FrameKind.End:
        onEndFrame(st, header.streamId)
        break
      case FrameKind.Reset:
        onResetFrame(st, header.streamId)
        break
      case FrameKind.Ack:
        onAckFrame(st, header.streamId, plaintext)
        break
      case FrameKind.Ping:
        break
    }
  }

  return {
    attachSocket(sink) {
      send = sink
      // A fresh socket = a fresh connection. Draw a fresh daemon salt, drop any prior connection state
      // (per-device connKeys/opener/sealer + stream bindings + pending phone salts), and announce the
      // salt UNSEALED so each phone can derive its connKeys. This re-keys on every daemon reconnect for
      // free (the controller rebuilds the bridge per socket open). Each phone's salt arrives next as an
      // inbound ConnSalt.
      daemonConnSalt = genConnSalt()
      pendingPhoneSalts.length = 0
      devices.clear()
      retiredPhoneSalts.clear()
      streamOwner.clear()
      emitDaemonSalt()
    },

    onInbound(frame) {
      const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame
      if (bytes.byteLength < HEADER_BYTES) {
        audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'short frame' })
        return
      }
      const headerBytes = bytes.subarray(0, HEADER_BYTES)
      const ciphertext = bytes.subarray(HEADER_BYTES)
      let header: ReturnType<typeof decodeHeader>
      try {
        header = decodeHeader(headerBytes)
      } catch {
        // No trusted streamId to Reset against — drop + audit (invariant 5).
        audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'bad_header' })
        return
      }

      // UNSEALED phone ConnSalt (M6.1) — handled BEFORE any open. We branch on the cleartext streamId
      // (CONN_SALT_STREAM_ID), never on a payload byte (a sealed frame's byte 0 is uniform-random
      // ciphertext). The salt is PUBLIC (HKDF salt needs no secrecy); device AUTHENTICATION is the
      // sealed Hello trial-open under the derived connKey, not this frame.
      if (header.streamId === CONN_SALT_STREAM_ID) {
        if (!isConnSaltPayload(ciphertext)) {
          audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'bad_header' })
          return
        }
        let msg: ReturnType<typeof decodeConnSalt>
        try {
          msg = decodeConnSalt(ciphertext)
        } catch {
          audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'bad_header' })
          return
        }
        if (msg.role === 'device') {
          // Remember this phone's salt as a CANDIDATE for the next unbound device to bind under. We do
          // NOT clear the device cache (HARDEN major 4): the relay multiplexes N phones over one socket,
          // so wiping every device's frozen connKeys on a second phone's ConnSalt would desync the
          // already-bound ones. The (root × pending salt) trial-open in resolveAndOpen pairs a salt to
          // the right device when its Hello arrives — so interleaved phone handshakes can't cross-bind.
          // Re-emit the daemon salt so a phone that began its channel on an already-open socket (no
          // fresh attachSocket) gets the bytes it needs to derive.
          rememberPhoneSalt(msg.salt)
          emitDaemonSalt()
        }
        return
      }

      const opened = resolveAndOpen(header.streamId, header.seq, headerBytes, ciphertext)
      if (!opened) {
        // AEAD/seq failure OR no device key. We never trust an unopened frame's routing, so we do
        // NOT emit a Reset (we cannot seal one for an unauthenticated stream) — just drop + audit.
        const known = streamOwner.has(header.streamId) || ctx.deviceSessions.candidates().length > 0
        audit.enqueue({
          action: 'reject',
          result: 'rejected',
          rejectReason: known ? 'open_failed' : 'no_session',
        })
        return
      }

      handleOpened(opened.device, header, opened.plaintext)
    },

    resetAllStreams(reason, opts) {
      const keepSink = opts?.keepSink ?? false
      for (const key of [...streams.keys()]) {
        const sb = streams.get(key)
        if (sb && !sb.closed) {
          const st = devices.get(sb.deviceId)
          if (st && send) {
            try {
              sendReset(st, extractStreamId(key), ResetCode.InternalError)
            } catch {
              // socket gone; just tear down locally
            }
          }
        }
        tearDownStream(key, 'reset')
      }
      if (keepSink) {
        // peer-offline: the socket is still up. Reset the streams, audit it as a stream-reset, but
        // leave the sink intact so the phone can re-open streams on the same socket once it's back.
        // NOT a session_close — no session/socket closed (the controller keeps the daemon socket).
        audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: reason })
        return
      }
      audit.enqueue({ action: 'session_close', result: 'ok', rejectReason: reason })
      send = null
    },

    closeDevice(deviceId, reason) {
      for (const key of [...streams.keys()]) {
        const sb = streams.get(key)
        if (!sb || sb.deviceId !== deviceId) continue
        const st = devices.get(deviceId)
        if (st && send) {
          try {
            sendReset(st, extractStreamId(key), ResetCode.InternalError)
          } catch {
            // socket gone; tear down locally below
          }
        }
        tearDownStream(key, 'reset')
      }
      // Drop the per-device opener/sealer so a re-pair of the same id starts clean (no stale seq).
      devices.delete(deviceId)
      audit.enqueue({ action: 'revoke', deviceId, result: 'ok', rejectReason: reason })
    },
  }
}
