// @vitest-environment jsdom
//
// TunnelTransport unit tests. The crypto + protocol are the REAL M1 modules — only "the other end of
// the wire" is a fixture: an in-test daemon-side opener that opens the phone's sealed frames with the
// matching session key, runs a fake handler, and seals the response back. Every assert here must FAIL
// if the product is reversed (tamper -> error, in-flight drop -> fail not hang, cookie dropped -> 403
// forever, binary coerced to text, etc).

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GW_CONTROL_PREFIX, RelayCloseCode } from '../../src/server/remote-control-constants.js'
import { classifyOpen } from '../../src/shared/remote-bridge-routing.js'
import {
  type ConnectionKeys,
  createOpener,
  createSealer,
  deriveConnectionKeys,
  deriveDaemonSession,
  deriveDeviceSession,
  type FrameOpener,
  type FrameSealer,
  generateConnSalt,
  type HandshakeIds,
  openNext,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
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
  FrameKind,
  HEADER_BYTES,
  isConnSaltPayload,
  ResetCode,
  type StreamMeta,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'
import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'
import { directTransport } from '../../web/src/transport/direct-transport.js'
import {
  createTunnelTransport,
  type TunnelSession,
} from '../../web/src/transport/tunnel-transport.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── a real (phone, daemon) session pair, both halves exposed ─────────────────────────────────────
// Unlike remote-test-session's createTestSession (which only surfaces the daemon keys + a phone peer),
// the tunnel needs the phone's raw d2p/p2d to build a TunnelSession AND the daemon keys for the double.

interface Pair {
  deviceId: string
  daemonId: string
  phone: { d2p: Uint8Array; p2d: Uint8Array }
  daemon: { d2p: Uint8Array; p2d: Uint8Array }
}

const makePair = (opts: { deviceId?: string; daemonId?: string } = {}): Pair => {
  const deviceId = opts.deviceId ?? 'device-tunnel-1'
  const daemonId = opts.daemonId ?? 'daemon-tunnel'
  const ids: HandshakeIds = { daemonId, deviceId, protocolVersion: REMOTE_CRYPTO_VERSION }
  const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = randomBytes(32)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const daemonPk = x25519.getPublicKey(daemonSk)
  const devicePk = x25519.getPublicKey(deviceSk)
  const daemon = deriveDaemonSession({
    daemonSecretKey: daemonSk,
    devicePublicKey: devicePk,
    daemonPublicKey: daemonPk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  const phone = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  return {
    deviceId,
    daemonId,
    phone: { d2p: phone.d2p, p2d: phone.p2d },
    daemon: { d2p: daemon.d2p, p2d: daemon.p2d },
  }
}

// ── an in-memory relay wire that the FakeRelaySocket plugs into ──────────────────────────────────
// One side is the phone (TunnelTransport via injected WebSocketImpl), the other is the daemon double.

type WireListener = (frame: Uint8Array) => void

// A WebSocket double the TunnelTransport's relay-socket opens. It wires bytes both ways through the
// shared ActiveWire and lets the test drive control frames + closes. Mirrors only what relay-socket uses.
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readonly OPEN = 1
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  url: string
  protocols: string | string[] | undefined
  private wire: ActiveWire

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    this.wire = currentWire
    this.wire.attachPhone(this)
    // open on the next microtask, like a real socket
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') {
      // heartbeat ping / text — daemon double ignores hb:ping (DO auto-pongs); record it
      this.wire.phoneSentText(data)
      return
    }
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength
            )
    this.wire.phoneSentFrame(Uint8Array.from(bytes))
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(reason === undefined ? { code: code ?? 1000 } : { code: code ?? 1000, reason })
  }

  // test-driven inbound
  deliverFrame(frame: Uint8Array): void {
    if (this.readyState !== 1) return
    this.onmessage?.({
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    })
  }

  deliverText(text: string): void {
    if (this.readyState !== 1) return
    this.onmessage?.({ data: text })
  }

  forceClose(code: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(reason === undefined ? { code } : { code, reason })
  }
}

// Holds the live phone socket so the daemon double + test can push to it.
class ActiveWire {
  private phone: FakeWebSocket | null = null
  private phoneFrameCbs: WireListener[] = []
  private phoneTextCbs: ((t: string) => void)[] = []

  attachPhone(ws: FakeWebSocket): void {
    this.phone = ws
  }
  phoneSentFrame(frame: Uint8Array): void {
    for (const cb of this.phoneFrameCbs) cb(frame)
  }
  phoneSentText(t: string): void {
    for (const cb of this.phoneTextCbs) cb(t)
  }
  onPhoneFrame(cb: WireListener): void {
    this.phoneFrameCbs.push(cb)
  }
  onPhoneText(cb: (t: string) => void): void {
    this.phoneTextCbs.push(cb)
  }
  pushToPhone(frame: Uint8Array): void {
    this.phone?.deliverFrame(frame)
  }
  pushTextToPhone(t: string): void {
    this.phone?.deliverText(t)
  }
  dropPhone(code: number, reason?: string): void {
    this.phone?.forceClose(code, reason)
  }
}

let currentWire = new ActiveWire()

// ── the daemon-side opener double ────────────────────────────────────────────────────────────────
// Plays the daemon: opens phone frames with p2d, runs a handler, seals responses with d2p. Uses the
// REAL M1 crypto/protocol — the only fixture part is the handler.

interface HttpHandlerResult {
  status: number
  headers?: Array<[string, string]>
  body?: Uint8Array | string
}

interface DaemonDouble {
  /** Set the response for the next HTTP open (or a function of the opened request). */
  onHttp(
    handler: (req: {
      method: string
      path: string
      headers: Array<[string, string]>
      body: Uint8Array
    }) => HttpHandlerResult
  ): void
  /** Echo every phone ws message back on the same stream (binary-safe). */
  echoWs(): void
  /** Tamper: flip one byte of the next sealed response ciphertext. */
  tamperNext(): void
  /** Drop the daemon->phone response before the head (drops the open frame's stream entirely). */
  dropBeforeHead(): void
  /** Stream ids the daemon opened, with the opened request. */
  readonly httpRequests: Array<{
    method: string
    path: string
    headers: Array<[string, string]>
    body: Uint8Array
  }>
  /** The classifyOpen decision the daemon reached for each WS Open it saw (in order). */
  readonly wsOpenDecisions: Array<ReturnType<typeof classifyOpen>>
}

const te = new TextEncoder()
const td = new TextDecoder()

const startDaemonDouble = (pair: Pair, wire: ActiveWire): DaemonDouble => {
  const dIds: HandshakeIds = {
    daemonId: pair.daemonId,
    deviceId: pair.deviceId,
    protocolVersion: REMOTE_CRYPTO_VERSION,
  }
  // M6.1: the persisted pair.daemon keys are ROOTS. The daemon draws a daemonConnSalt, sees the
  // device's phoneConnSalt on the unsealed channel open, derives the per-connection connKeys, and
  // seals/opens under connKeys — never the root. opener/sealer are armed once connKeys exist.
  let daemonConnSalt: Uint8Array = generateConnSalt()
  let phoneConnSalt: Uint8Array | null = null
  let connKeys: ConnectionKeys | null = null
  let opener: FrameOpener | null = null // daemon OPENS p2d (phone->daemon)
  let sealer: FrameSealer | null = null // daemon SEALS d2p (daemon->phone)

  const emitDaemonSalt = (): void => {
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: CONN_SALT_STREAM_ID,
      seq: 0,
    })
    const body = encodeConnSalt({ role: 'daemon', salt: daemonConnSalt })
    const out = new Uint8Array(headerBytes.length + body.length)
    out.set(headerBytes, 0)
    out.set(body, headerBytes.length)
    wire.pushToPhone(out)
  }

  const armConnKeys = (): void => {
    if (!phoneConnSalt) return
    connKeys = deriveConnectionKeys({
      rootD2p: pair.daemon.d2p,
      rootP2d: pair.daemon.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids: dIds,
    })
    opener = createOpener('p2d')
    sealer = createSealer('d2p')
  }

  let httpHandler:
    | ((req: {
        method: string
        path: string
        headers: Array<[string, string]>
        body: Uint8Array
      }) => HttpHandlerResult)
    | null = null
  let echo = false
  let tamper = false
  let dropHead = false
  const httpRequests: Array<{
    method: string
    path: string
    headers: Array<[string, string]>
    body: Uint8Array
  }> = []

  interface HttpStream {
    meta: StreamMeta
    body: Uint8Array[]
    dropped: boolean
  }
  const httpStreams = new Map<number, HttpStream>()
  const wsStreams = new Set<number>()
  const wsOpenDecisions: Array<ReturnType<typeof classifyOpen>> = []

  const seal = (kind: FrameKind, streamId: number, payload: Uint8Array, flags = 0): Uint8Array => {
    if (!sealer || !connKeys) throw new Error('daemon double: seal before connKeys armed')
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind,
      flags,
      streamId,
      seq: sealer.nextSeq,
    })
    const { ciphertext } = sealNext(sealer, {
      key: connKeys.d2p,
      streamId,
      headerBytes,
      payload,
    })
    const out = new Uint8Array(headerBytes.length + ciphertext.length)
    out.set(headerBytes, 0)
    out.set(ciphertext, headerBytes.length)
    if (tamper) {
      tamper = false
      // flip a ciphertext byte so the phone's openNext throws (AEAD fail).
      out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 0x01
    }
    return out
  }

  const completeHttp = (streamId: number, st: HttpStream): void => {
    if (st.dropped) return
    const req = {
      method: st.meta.http?.method ?? 'GET',
      path: st.meta.http?.path ?? '',
      headers: st.meta.http?.headers ?? [],
      body: concat(st.body),
    }
    httpRequests.push(req)
    const result = httpHandler?.(req) ?? { status: 404 }
    const bodyBytes =
      result.body === undefined
        ? new Uint8Array(0)
        : typeof result.body === 'string'
          ? te.encode(result.body)
          : result.body
    if (dropHead) {
      dropHead = false
      // model an in-flight drop: never send head/body, just drop the socket
      wire.dropPhone(1006)
      return
    }
    wire.pushToPhone(
      seal(
        FrameKind.Data,
        streamId,
        encodeHttpHead({ status: result.status, headers: result.headers ?? [] })
      )
    )
    if (bodyBytes.length > 0) {
      wire.pushToPhone(seal(FrameKind.Data, streamId, encodeHttpBodyChunk(bodyBytes)))
    }
    wire.pushToPhone(seal(FrameKind.End, streamId, new Uint8Array(0)))
  }

  wire.onPhoneFrame((frame) => {
    const headerBytes = frame.subarray(0, HEADER_BYTES)
    const ciphertext = frame.subarray(HEADER_BYTES)
    const header = decodeHeader(headerBytes)
    // UNSEALED device ConnSalt: arm connKeys under the agreed bilateral salts. Demux on the cleartext
    // streamId (never on a payload byte that, for a sealed frame, would be random ciphertext).
    if (header.streamId === CONN_SALT_STREAM_ID && isConnSaltPayload(ciphertext)) {
      const msg = decodeConnSalt(ciphertext)
      if (msg.role === 'device') {
        phoneConnSalt = msg.salt
        daemonConnSalt = generateConnSalt() // fresh daemon half per channel open (reconnect re-keys)
        armConnKeys() // opener ready BEFORE the sealed Hello arrives
        emitDaemonSalt() // phone derives the matching connKeys + seals its Hello
      }
      return
    }
    if (!opener || !connKeys) return // a sealed frame before the salt exchange — drop
    let plaintext: Uint8Array
    try {
      plaintext = openNext(opener, {
        key: connKeys.p2d,
        streamId: header.streamId,
        headerBytes,
        ciphertext,
        seq: header.seq,
      })
    } catch {
      return // a frame the daemon can't open — drop (matches real daemon)
    }
    if (header.streamId === CHANNEL_STREAM_ID) return // sealed Hello binds the device; nothing to answer
    if (header.kind === FrameKind.Open) {
      const meta = decodeOpenPayload(plaintext)
      // Honor the REAL daemon whitelist (remote-frame-bridge runs classifyOpen on every Open; a
      // rejected decision is a Reset(StreamRefused), never a bridged stream). The double cannot be
      // more permissive than the daemon or the suite passes against a daemon that cannot exist.
      const decision = classifyOpen(meta)
      if (meta.transport === StreamTransport.Http) {
        if (!decision.ok) {
          wire.pushToPhone(
            seal(FrameKind.Reset, header.streamId, encodeResetPayload(ResetCode.StreamRefused))
          )
          return
        }
        const st: HttpStream = { meta, body: [], dropped: false }
        httpStreams.set(header.streamId, st)
        if (!meta.http?.hasBody) completeHttp(header.streamId, st)
      } else {
        wsOpenDecisions.push(decision)
        if (!decision.ok) {
          wire.pushToPhone(
            seal(FrameKind.Reset, header.streamId, encodeResetPayload(ResetCode.StreamRefused))
          )
          return
        }
        wsStreams.add(header.streamId)
      }
      return
    }
    if (header.kind === FrameKind.Data) {
      const httpSt = httpStreams.get(header.streamId)
      if (httpSt) {
        const chunk = decodeHttpData(plaintext)
        if (chunk.kind === 'body') httpSt.body.push(chunk.data)
        return
      }
      if (wsStreams.has(header.streamId) && echo) {
        const msg = decodeWsMessage(plaintext)
        wire.pushToPhone(
          seal(FrameKind.Data, header.streamId, encodeWsMessage(msg.data, msg.isText))
        )
      }
      return
    }
    if (header.kind === FrameKind.End) {
      const httpSt = httpStreams.get(header.streamId)
      if (httpSt && httpSt.body.length >= 0 && !httpSt.dropped && httpSt.meta.http?.hasBody) {
        completeHttp(header.streamId, httpSt)
      }
      return
    }
  })

  return {
    onHttp(handler) {
      httpHandler = handler
    },
    echoWs() {
      echo = true
    },
    tamperNext() {
      tamper = true
    },
    dropBeforeHead() {
      dropHead = true
    },
    httpRequests,
    wsOpenDecisions,
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// ── harness ──────────────────────────────────────────────────────────────────────────────────────

interface Harness {
  pair: Pair
  daemon: DaemonDouble
  transport: ReturnType<typeof createTunnelTransport>
  statuses: Array<{ state: string; reason?: string; nextRetryInMs?: number }>
  wire: ActiveWire
  flushOpen(): Promise<void>
}

const makeSession = (pair: Pair): TunnelSession => ({
  roots: { d2p: pair.phone.d2p, p2d: pair.phone.p2d },
  deviceId: pair.deviceId,
  daemonId: pair.daemonId,
  gatewayUrl: 'wss://app.hivehq.dev',
  phoneSessionToken: 'phone-jwt-token',
})

const setupHarness = (): Harness => {
  const pair = makePair()
  const wire = new ActiveWire()
  currentWire = wire
  const daemon = startDaemonDouble(pair, wire)
  const statuses: Array<{ state: string; reason?: string; nextRetryInMs?: number }> = []
  const transport = createTunnelTransport({
    session: makeSession(pair),
    onStatus: (s) => statuses.push({ ...s }),
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  })
  return {
    pair,
    daemon,
    transport,
    statuses,
    wire,
    // let the queued-microtask open fire + any pending sealing settle
    flushOpen: async () => {
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('TunnelTransport.fetch — HTTP over the E2E relay', () => {
  // T1 — a GET round-trips through real crypto: the daemon double opens the Open, seals a JSON head +
  // body, and the phone reassembles a Response. A 500 must surface as 500, not a fabricated 200.
  test('T1: reassembles status + JSON body from sealed daemon frames', async () => {
    const h = setupHarness()
    h.daemon.onHttp((req) => {
      expect(req.method).toBe('GET')
      expect(req.path).toBe('/api/workspaces')
      return {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: JSON.stringify([{ id: 'w1' }]),
      }
    })
    await h.flushOpen()
    const res = await h.transport.fetch('/api/workspaces')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'w1' }])

    const h2 = setupHarness()
    h2.daemon.onHttp(() => ({ status: 500, body: 'boom' }))
    await h2.flushOpen()
    const res2 = await h2.transport.fetch('/api/version')
    expect(res2.status).toBe(500)
  })

  // T2 — POST body + content-type ride faithfully: the daemon double sees the exact method, path,
  // body bytes, and the header list (including the content-type the caller set).
  test('T2: POST body + headers arrive byte-exact on the daemon side', async () => {
    const h = setupHarness()
    h.daemon.onHttp(() => ({ status: 201, body: '{"ok":true}' }))
    await h.flushOpen()
    const body = JSON.stringify({ name: 'x', path: '/p' })
    await h.transport.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const req = h.daemon.httpRequests.at(-1)
    expect(req?.method).toBe('POST')
    expect(req?.path).toBe('/api/workspaces')
    expect(td.decode(req?.body ?? new Uint8Array())).toBe(body)
    expect(
      req?.headers.some(([k, v]) => k.toLowerCase() === 'content-type' && v === 'application/json')
    ).toBe(true)
  })

  // T7 (adversarial core) — a tampered ciphertext must fail openNext and reject the fetch. NO partial
  // or garbage Response is ever surfaced. If the product trusts the header without openNext, this passes
  // a bogus Response and the test fails.
  test('T7: a tampered response frame rejects the fetch (never a garbage Response)', async () => {
    const h = setupHarness()
    h.daemon.onHttp(() => ({ status: 200, body: 'secret' }))
    h.daemon.tamperNext()
    await h.flushOpen()
    await expect(h.transport.fetch('/api/version')).rejects.toThrow()
  })

  // T8 (adversarial core) — the socket drops before the head arrives. The fetch promise must reject in
  // bounded time, never hang forever (the Transport Contract: 在途断 -> 明确失败).
  test('T8: an in-flight socket drop rejects the pending fetch instead of hanging', async () => {
    const h = setupHarness()
    h.daemon.dropBeforeHead()
    h.daemon.onHttp(() => ({ status: 200, body: 'never' }))
    await h.flushOpen()
    await expect(h.transport.fetch('/api/workspaces')).rejects.toThrow()
  })

  // H-NET-3 (weak-network long-tail) — pin the fast-fail: an in-flight fetch must reject on the
  // VERY drop (relay onclose -> onDown -> mux.resetAll), NOT after any timer/backoff. We drop the
  // relay with the request still in flight and assert the promise settles within a couple of
  // microtask turns under fake timers WITHOUT advancing any timer. If a future change makes the
  // reject depend on a timeout, this test hangs (and the suite catches the regression).
  test('H-NET-3: a mid-flight relay drop rejects the fetch within a tick (no timer advance)', async () => {
    vi.useFakeTimers()
    try {
      const pair = makePair()
      const wire = new ActiveWire()
      currentWire = wire
      const daemon = startDaemonDouble(pair, wire)
      // The daemon drops the relay mid-flight instead of answering (no head ever sent).
      daemon.dropBeforeHead()
      daemon.onHttp(() => ({ status: 200, body: 'never-delivered' }))
      const transport = createTunnelTransport({
        session: makeSession(pair),
        onStatus: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      await vi.advanceTimersByTimeAsync(1) // let the relay open + Hello settle

      let settled: 'pending' | 'rejected' | 'resolved' = 'pending'
      const p = transport
        .fetch('/api/workspaces')
        .then(() => {
          settled = 'resolved'
        })
        .catch(() => {
          settled = 'rejected'
        })

      // The drop happens as the daemon double processes the Open (dropBeforeHead -> dropPhone). The
      // reject must come from relay onclose -> onDown -> mux.resetAll, NOT from any timer/backoff.
      // Only microtask turns — NO advanceTimersByTime. If the reject depended on a timeout this hangs.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await p
      expect(settled).toBe('rejected')
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TunnelTransport E2E confidentiality — invariant 4 (gateway sees only ciphertext)', () => {
  // T3 — the request body + headers are sealed INSIDE the M1 frame; the raw plaintext never appears in
  // any byte the relay wire (the gateway) forwards. The daemon double opens the frame and confirms it
  // received the exact body, so the relay carried it — but only as AEAD ciphertext.
  //
  // (There is NO UI cookie jar: tunnel /api/* is authorized by the daemon's per-boot internal secret,
  // and /api/ui/session is hard-denied to the tunnel, so the phone never holds hive_ui_token. The old
  // T3 cookie-replay test exercised a daemon contract that does not exist — see tunnel-transport.ts.)
  test('T3: request body + headers ride sealed; never leak in cleartext on the relay wire', async () => {
    const cleartextFrames: Uint8Array[] = []
    const h = setupHarness()
    h.wire.onPhoneFrame((f) => cleartextFrames.push(f))
    let seenBody: string | null = null
    let seenHeader: string | undefined
    h.daemon.onHttp((req) => {
      seenBody = td.decode(req.body)
      seenHeader = req.headers.find(([k]) => k.toLowerCase() === 'x-secret')?.[1]
      return { status: 200, body: 'ok' }
    })
    await h.flushOpen()
    const secretBody = JSON.stringify({ password: 'SECRET-BODY-9999' })
    const res = await h.transport.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-secret': 'SECRET-HEADER-8888' },
      body: secretBody,
    })
    expect(res.status).toBe(200)
    // the daemon really received the sealed body + header (so the relay carried them)...
    expect(seenBody).toBe(secretBody)
    expect(seenHeader).toBe('SECRET-HEADER-8888')
    // ...but neither secret appears anywhere in the raw frames the relay/gateway forwards (ciphertext).
    const haystack = td.decode(concat(cleartextFrames))
    expect(haystack.includes('SECRET-BODY-9999')).toBe(false)
    expect(haystack.includes('SECRET-HEADER-8888')).toBe(false)
  })
})

describe('TunnelTransport WS — both directions over the relay', () => {
  test('mixed Chinese, English, emoji, and punctuation round-trip as one text frame', async () => {
    const h = setupHarness()
    h.daemon.echoWs()
    await h.flushOpen()
    const socket = h.transport.openWebSocket('/ws/terminal/r1/io', { clientId: 'unicode' })
    const received: unknown[] = []
    socket.onmessage = (event) => received.push(event.data)
    await waitFor(() => socket.readyState === socket.OPEN)
    const payload = '中文，English 😀。`代码`'

    socket.send(payload)

    await waitFor(() => received.length > 0)
    expect(received).toEqual([payload])
    expect(typeof received[0]).toBe('string')
  })

  // T5 — binary stays binary: the phone sends a binary ws message, the daemon echoes it, and the phone
  // delivers byte-exact bytes on onmessage. No utf-8 coercion of binary stdin.
  test('T5: binary ws message round-trips byte-exact (no text coercion)', async () => {
    const h = setupHarness()
    h.daemon.echoWs()
    await h.flushOpen()
    const sock = h.transport.openWebSocket('/ws/terminal/r1/io', { clientId: 'c1' })
    const received: Array<string | ArrayBufferLike | Uint8Array> = []
    sock.onmessage = (ev) => received.push(ev.data)
    await waitFor(() => sock.readyState === sock.OPEN)
    const payload = new Uint8Array([0x00, 0xff, 0x1b, 0x5b, 0x41])
    sock.send(payload)
    await waitFor(() => received.length > 0)
    const got = received[0]
    const gotBytes = got instanceof Uint8Array ? got : new Uint8Array(got as ArrayBufferLike)
    expect(Array.from(gotBytes)).toEqual(Array.from(payload))
  })

  // T6 — io + control open as two independent streams carrying their query params in the Open meta; a
  // text frame (resize/output_ack JSON) round-trips as text.
  test('T6: io + control are two streams; text frames round-trip as text', async () => {
    const h = setupHarness()
    h.daemon.echoWs()
    await h.flushOpen()
    const io = h.transport.openWebSocket('/ws/terminal/r1/io', {
      clientId: 'c1',
      cols: 80,
      rows: 24,
    })
    const control = h.transport.openWebSocket('/ws/terminal/r1/control', { clientId: 'c1' })
    await waitFor(() => io.readyState === io.OPEN && control.readyState === control.OPEN)
    const ioMsgs: string[] = []
    const ctlMsgs: string[] = []
    io.onmessage = (ev) => ioMsgs.push(String(ev.data))
    control.onmessage = (ev) => ctlMsgs.push(String(ev.data))
    control.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))
    await waitFor(() => ctlMsgs.length > 0)
    expect(ctlMsgs[0]).toBe(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))
    // the io stream did not receive the control echo (two distinct streams)
    expect(ioMsgs.length).toBe(0)

    // CONTRACT: clientId/cols/rows rode the separate StreamMeta.ws.query field, never the path. The
    // daemon's classifyOpen therefore accepted a BARE whitelisted path and surfaced the query as pairs
    // — the only shape the real bridge accepts (a '?' in the WS path is path_not_canonical).
    const ioDecision = h.daemon.wsOpenDecisions[0]
    expect(ioDecision?.ok).toBe(true)
    if (ioDecision?.ok && ioDecision.transport === 'ws') {
      expect(ioDecision.path).toBe('/ws/terminal/r1/io')
      expect(ioDecision.path.includes('?')).toBe(false)
      expect(ioDecision.query).toEqual([
        ['clientId', 'c1'],
        ['cols', '80'],
        ['rows', '24'],
      ])
    }
  })

  // T6b (regression for the WS-param contract) — the real M3 daemon's classifyOpen REJECTS a query
  // smuggled into the WS path (path_not_canonical) but ACCEPTS a bare whitelisted path with the query
  // riding the separate StreamMeta.ws.query field. This is the end-to-end contract the phone's startWs
  // must satisfy; baking params into the path (the old behavior) would be Reset on the real tunnel.
  test('T6b: a query-in-path WS open is rejected; the separate query field is accepted', () => {
    const inPath = classifyOpen({
      transport: StreamTransport.Ws,
      ws: { path: '/ws/terminal/r1/io?clientId=c1' },
    })
    expect(inPath.ok).toBe(false)
    if (!inPath.ok) expect(inPath.reason).toBe('path_not_canonical')

    const separate = classifyOpen({
      transport: StreamTransport.Ws,
      ws: { path: '/ws/terminal/r1/io', query: [['clientId', 'c1']] },
    })
    expect(separate.ok).toBe(true)
    if (separate.ok && separate.transport === 'ws') {
      expect(separate.path).toBe('/ws/terminal/r1/io')
      expect(separate.query).toEqual([['clientId', 'c1']])
    }
  })
})

describe('TunnelTransport reconnect + banner — status signal', () => {
  // T9 — a transient drop emits 'reconnecting' (with a retry hint) and recovers to 'online'; a 4401
  // (auth-fatal) latches 'revoked' and does not retry.
  test('T9: transient drop reconnects; 4401 latches revoked with no retry', async () => {
    vi.useFakeTimers()
    try {
      const pair = makePair()
      const wire = new ActiveWire()
      currentWire = wire
      startDaemonDouble(pair, wire)
      const statuses: Array<{ state: string }> = []
      const transport = createTunnelTransport({
        session: makeSession(pair),
        onStatus: (s) => statuses.push({ state: s.state }),
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      await vi.advanceTimersByTimeAsync(1)
      expect(statuses.map((s) => s.state)).toContain('online')

      // transient close
      wire.dropPhone(1006)
      expect(statuses.map((s) => s.state)).toContain('reconnecting')
      // backoff fires -> reconnect -> online again
      await vi.advanceTimersByTimeAsync(60_000)
      expect(statuses.filter((s) => s.state === 'online').length).toBeGreaterThanOrEqual(2)

      // now an auth-fatal close
      wire.dropPhone(4401, 'unauthorized')
      const before = statuses.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(statuses.at(-1)?.state).toBe('revoked')
      // no further status churn after revoked latch (no reconnect attempts)
      expect(statuses.length).toBe(before)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // T9b (HARDEN: revoked-during-backoff) — a NON-101 upgrade response (HTTP 403 from relayDevice during
  // a reconnect) must latch 'revoked', distinct from a 1006/4404 transient retry loop.
  test('T9b: a non-101 upgrade response (403) latches revoked, no infinite retry', async () => {
    vi.useFakeTimers()
    try {
      const pair = makePair()
      const wire = new ActiveWire()
      currentWire = wire
      startDaemonDouble(pair, wire)
      const statuses: Array<{ state: string }> = []
      // a socket impl whose FIRST instance opens, but reconnect attempts get a 403 (close 4403 before open)
      let instances = 0
      class RevokeOnReconnectSocket extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols)
          instances += 1
          if (instances > 1) {
            // Suppress the base class's queued open (its microtask skips when readyState !== 0) and
            // surface a 403-equivalent upgrade failure (Forbidden 4403) BEFORE any open — the real
            // non-101 relay-upgrade rejection a revoked-during-backoff device would hit.
            this.readyState = 2
            queueMicrotask(() => {
              this.readyState = 3
              this.onclose?.({ code: 4403, reason: 'forbidden' })
            })
          }
        }
      }
      const transport = createTunnelTransport({
        session: makeSession(pair),
        onStatus: (s) => statuses.push({ state: s.state }),
        WebSocketImpl: RevokeOnReconnectSocket as unknown as typeof WebSocket,
      })
      await vi.advanceTimersByTimeAsync(1)
      wire.dropPhone(1006) // transient -> reconnect scheduled
      await vi.advanceTimersByTimeAsync(120_000)
      expect(statuses.at(-1)?.state).toBe('revoked')
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('T9c: daemon-offline give-up emits a manual retry hook and retry resumes the relay', async () => {
    vi.useFakeTimers()
    try {
      const pair = makePair()
      currentWire = new ActiveWire()
      const statuses: Array<{ state: string; retry?: () => void }> = []
      let instances = 0
      class OfflineSocket extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols)
          instances += 1
          // Suppress the base class queued open and model the gateway rejecting the upgrade because
          // the daemon is offline. This is the H-NET-2 path where relay-socket eventually stops
          // automatic retries and requires a user-driven resume().
          this.readyState = 2
          queueMicrotask(() => {
            this.readyState = 3
            this.onclose?.({ code: RelayCloseCode.DaemonOffline, reason: 'daemon offline' })
          })
        }
      }

      const transport = createTunnelTransport({
        session: makeSession(pair),
        onStatus: (s) => statuses.push({ state: s.state, ...(s.retry ? { retry: s.retry } : {}) }),
        WebSocketImpl: OfflineSocket as unknown as typeof WebSocket,
      })

      for (let i = 0; i < 10 && statuses.at(-1)?.state !== 'disconnected'; i++) {
        await vi.advanceTimersByTimeAsync(60_000)
      }

      const disconnected = statuses.find((s) => s.state === 'disconnected')
      expect(disconnected?.retry).toEqual(expect.any(Function))
      const beforeRetry = instances
      disconnected?.retry?.()
      expect(instances).toBe(beforeRetry + 1)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('T9d: duplicate daemon peer-online on an already-ready socket is a no-op', async () => {
    const h = setupHarness()
    const sent: Uint8Array[] = []
    h.wire.onPhoneFrame((frame) => sent.push(frame))
    h.daemon.onHttp(() => ({ status: 200, body: 'ok' }))
    await h.flushOpen()
    await h.transport.ready()

    const countDeviceConnSalts = (): number =>
      sent.filter((frame) => {
        const header = decodeHeader(frame.subarray(0, HEADER_BYTES))
        const payload = frame.subarray(HEADER_BYTES)
        return (
          header.streamId === CONN_SALT_STREAM_ID &&
          isConnSaltPayload(payload) &&
          decodeConnSalt(payload).role === 'device'
        )
      }).length

    const before = countDeviceConnSalts()
    h.wire.pushTextToPhone(
      `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-online', role: 'daemon' })}`
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(countDeviceConnSalts()).toBe(before)

    const res = await h.transport.fetch('/api/version')
    expect(res.status).toBe(200)
    h.transport.dispose()
  })
})

describe('TunnelTransport silent rebuild — page refresh', () => {
  // T10 — constructed with no live session but a persistedSession() the transport re-derives from; a
  // fetch still works without a re-scan.
  test('T10: rebuilds from persistedSession and serves a fetch', async () => {
    const pair = makePair()
    const wire = new ActiveWire()
    currentWire = wire
    const daemon = startDaemonDouble(pair, wire)
    daemon.onHttp(() => ({ status: 200, body: 'ok' }))
    const statuses: Array<{ state: string }> = []
    const transport = createTunnelTransport({
      session: makeSession(pair),
      onStatus: (s) => statuses.push({ state: s.state }),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      persistedSession: () => makeSession(pair),
    })
    await Promise.resolve()
    await Promise.resolve()
    const res = await transport.fetch('/api/version')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    transport.dispose()
  })
})

// ── helpers ──

const waitFor = async (cond: () => boolean, tries = 50): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  if (!cond()) throw new Error('waitFor: condition never became true')
}

// ── T11: i18n coverage for the banner keys the transport status drives ──

const CONNECT_KEYS: TranslationKey[] = [
  'remote.connect.connecting',
  'remote.connect.reconnecting',
  'remote.connect.disconnected',
  'remote.connect.sessionExpired',
  'remote.connect.online',
]

const I18nProbe = ({ onToggle }: { onToggle: (toggle: () => void) => void }) => {
  const { t, setLanguage } = useI18n()
  onToggle(() => setLanguage('zh'))
  return (
    <ul>
      {CONNECT_KEYS.map((key) => (
        <li key={key} data-key={key}>
          {t(key)}
        </li>
      ))}
    </ul>
  )
}

describe('TunnelTransport i18n — banner keys (T11)', () => {
  test('T11: every connect/banner key resolves non-empty + distinct en vs zh', () => {
    let toggleZh = () => {}
    render(
      <I18nProvider>
        <I18nProbe onToggle={(fn) => (toggleZh = fn)} />
      </I18nProvider>
    )
    const readAll = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const k of CONNECT_KEYS) {
        out[k] = document.querySelector(`[data-key="${k}"]`)?.textContent ?? ''
      }
      return out
    }
    const en = readAll()
    act(() => toggleZh())
    const zh = readAll()
    for (const k of CONNECT_KEYS) {
      expect(en[k]?.length ?? 0, `missing en ${k}`).toBeGreaterThan(0)
      expect(zh[k]?.length ?? 0, `missing zh ${k}`).toBeGreaterThan(0)
      expect(en[k], `untranslated key ${k}`).not.toBe(k)
      expect(zh[k], `zh same as en ${k}`).not.toBe(en[k])
    }
  })
})

void directTransport
