import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteAuditStore,
  type RemoteAuditStore,
} from '../../src/server/remote-audit-store.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import { createFrameBridge } from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import { REMOTE_CRYPTO_VERSION } from '../../src/shared/remote-crypto.js'
import {
  decodeResetPayload,
  encodeHeader,
  encodeOpenPayload,
  FrameKind,
  ResetCode,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'
import { unwrapRelayRoute } from '../../src/shared/remote-relay-route.js'
import { createTestSession } from '../helpers/remote-test-session.js'

// Unit-level adversarial tests for THE cardinal demux invariant (invariant 5): the bridge must OPEN
// a frame (M1 openNext — AEAD integrity + seq replay guard) BEFORE it ever reads streamId/path and
// makes a loopback request. A tamper/replay/unknown-device frame is dropped + audited and NEVER
// bridged. We assert the loopback dispatcher (the thing that would actually open a 127.0.0.1 socket)
// is never invoked. No real network here — the bridge's loopback factories are stubbed so a single
// call would be observable; the crypto + routing are real.

describe('remote frame bridge — open-before-route guard (invariant 5)', () => {
  let db: InstanceType<typeof Database>
  let audit: RemoteAuditStore
  const outbound: Uint8Array[] = []
  const wsOpenPaths: string[] = []
  let dispatchCount: number
  let failHttpOpen: boolean
  let abortCount: number

  beforeEach(() => {
    db = new Database(':memory:')
    applySchemaVersion23(db)
    audit = createRemoteAuditStore(db)
    outbound.length = 0
    wsOpenPaths.length = 0
    dispatchCount = 0
    failHttpOpen = false
    abortCount = 0
  })

  afterEach(() => {
    db.close()
  })

  const DAEMON_ID = 'daemon-test'

  const build = (provider: ReturnType<typeof createTestSession>['provider']) => {
    const bridge = createFrameBridge({
      loopbackPort: 1, // never actually dialed in these tests
      loopbackSecret: 'secret',
      deviceSessions: provider,
      audit,
      daemonId: DAEMON_ID,
      // Stub the loopback transports so a single bridged request is observable WITHOUT real I/O.
      // If the guard is reversed (route-before-open), an unopened frame reaches here and bites.
      loopbackTransports: {
        openHttp: () => {
          dispatchCount += 1
          if (failHttpOpen) throw new Error('loopback unavailable')
          return {
            onData: () => {},
            onEnd: () => {},
            abort: () => {
              abortCount += 1
            },
          }
        },
        openWs: (args) => {
          dispatchCount += 1
          wsOpenPaths.push(args.path)
          return {
            onData: () => {},
            onClose: () => {},
            abort: () => {
              abortCount += 1
            },
          }
        },
      },
    })
    bridge.attachSocket((frame) => outbound.push(frame))
    return bridge
  }

  const toArrayBuffer = (u: Uint8Array): ArrayBuffer => {
    const out = new ArrayBuffer(u.byteLength)
    new Uint8Array(out).set(u)
    return out
  }

  // M6.1 channel handshake: attachSocket already emitted the daemon ConnSalt into `outbound`. Begin
  // the phone's channel (feed its ConnSalt to the bridge → the bridge re-emits its salt), then feed
  // the re-emitted daemon salt back to the phone so it derives the connKeys, and finally send the
  // sealed binding Hello so the daemon trial-opens + binds the device. Done as one atomic exchange so
  // the daemon's pending phoneConnSalt still matches this device when its Hello opens (multi-device).
  // (A real reload/reconnect runs this exact exchange over the relay socket.)
  const handshake = (
    bridge: ReturnType<typeof build>,
    device: ReturnType<typeof createTestSession>['device']
  ): void => {
    bridge.onInbound(toArrayBuffer(device.beginChannel()))
    // The most recent frame the daemon emitted is its (re-emitted) ConnSalt — arm the phone with it.
    const daemonSalt = outbound[outbound.length - 1]
    if (!daemonSalt) throw new Error('daemon did not emit a ConnSalt')
    device.open(daemonSalt)
    if (!device.armed()) throw new Error('phone failed to arm after the salt exchange')
    bridge.onInbound(toArrayBuffer(device.sealHello())) // binds the device under THIS connection's salts
  }

  // XOR a single byte at `idx` in place (noUncheckedIndexedAccess-safe).
  const flipByte = (u: Uint8Array, idx: number): Uint8Array => {
    u[idx] = (u[idx] ?? 0) ^ 0xff
    return u
  }

  it('resets a failed HTTP open and accepts the next stream', () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)
    const open = (sid: number) =>
      session.device.seal({
        kind: FrameKind.Open,
        streamId: sid,
        payload: encodeOpenPayload({
          transport: StreamTransport.Http,
          http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
        }),
      })
    const sid = session.device.nextStreamId()
    failHttpOpen = true
    bridge.onInbound(toArrayBuffer(open(sid)))
    const reset = session.device.open(unwrapRelayRoute(outbound.at(-1) as Uint8Array).frame)
    expect('header' in reset && reset.header).toMatchObject({
      kind: FrameKind.Reset,
      streamId: sid,
    })
    if ('plaintext' in reset)
      expect(decodeResetPayload(reset.plaintext)).toBe(ResetCode.InternalError)
    failHttpOpen = false
    bridge.onInbound(toArrayBuffer(open(session.device.nextStreamId())))
    expect(dispatchCount).toBe(2)
  })

  it('resets malformed data, aborts the stream, and accepts a subsequent stream', () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)
    const sid = session.device.nextStreamId()
    const open = (streamId: number) =>
      session.device.seal({
        kind: FrameKind.Open,
        streamId,
        payload: encodeOpenPayload({
          transport: StreamTransport.Http,
          http: { method: 'POST', path: '/api/workspaces', headers: [], hasBody: true },
        }),
      })
    bridge.onInbound(toArrayBuffer(open(sid)))
    bridge.onInbound(
      toArrayBuffer(
        session.device.seal({ kind: FrameKind.Data, streamId: sid, payload: new Uint8Array(0) })
      )
    )
    const reset = session.device.open(unwrapRelayRoute(outbound.at(-1) as Uint8Array).frame)
    expect('header' in reset && reset.header).toMatchObject({
      kind: FrameKind.Reset,
      streamId: sid,
    })
    if ('plaintext' in reset)
      expect(decodeResetPayload(reset.plaintext)).toBe(ResetCode.ProtocolError)
    expect(abortCount).toBe(1)
    bridge.onInbound(toArrayBuffer(open(session.device.nextStreamId())))
    expect(dispatchCount).toBe(2)
  })

  it('resets malformed WebSocket data and aborts the stream', () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)
    const sid = session.device.nextStreamId()
    bridge.onInbound(
      toArrayBuffer(
        session.device.seal({
          kind: FrameKind.Open,
          streamId: sid,
          payload: encodeOpenPayload({
            transport: StreamTransport.Ws,
            ws: { path: '/ws/terminal/run-9/control' },
          }),
        })
      )
    )
    bridge.onInbound(
      toArrayBuffer(
        session.device.seal({ kind: FrameKind.Data, streamId: sid, payload: new Uint8Array(0) })
      )
    )
    const reset = session.device.open(unwrapRelayRoute(outbound.at(-1) as Uint8Array).frame)
    expect('header' in reset && reset.header).toMatchObject({
      kind: FrameKind.Reset,
      streamId: sid,
    })
    if ('plaintext' in reset)
      expect(decodeResetPayload(reset.plaintext)).toBe(ResetCode.ProtocolError)
    expect(abortCount).toBe(1)
  })

  it('drops + audits a frame with flipped ciphertext (AEAD tamper), never dispatches', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)

    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    // Flip a ciphertext byte (after the 12-byte header). AEAD must fail to open.
    const tampered = flipByte(new Uint8Array(open), open.length - 1)
    bridge.onInbound(toArrayBuffer(tampered))

    await audit.flush()
    expect(dispatchCount).toBe(0)
    expect(
      audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
    ).toBe(true)
  })

  it('drops + audits a frame with a mutated header (AAD tamper), never dispatches', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)

    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    // Mutate the streamId field inside the header (offset 4..7). The header IS the AEAD AAD, so the
    // open must fail. The daemon must NOT trust this rewritten streamId.
    const mutated = new Uint8Array(open)
    mutated[7] = (mutated[7] ?? 0) ^ 0x01
    bridge.onInbound(toArrayBuffer(mutated))

    await audit.flush()
    expect(dispatchCount).toBe(0)
    expect(audit.list().some((r) => r.action === 'reject')).toBe(true)
  })

  it('drops + audits a replayed frame (seq guard), never double-dispatches', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device) // arms + binds the device via the sealed Hello

    // A real Open that DOES dispatch once.
    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    bridge.onInbound(toArrayBuffer(open))
    expect(dispatchCount).toBe(1)

    // Replay the SAME bytes. openNext's seq guard must reject it: no second dispatch.
    bridge.onInbound(toArrayBuffer(open))
    await audit.flush()
    expect(dispatchCount).toBe(1)
    expect(
      audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
    ).toBe(true)
  })

  it('drops + audits an Open for an unknown/revoked device (no session), never dispatches', async () => {
    // A device whose session is NOT in the provider: trial-open finds no candidate that authenticates.
    const known = createTestSession({ deviceId: 'known', daemonId: DAEMON_ID })
    const stranger = createTestSession({ deviceId: 'stranger', daemonId: DAEMON_ID })
    const bridge = build(known.provider) // only 'known' is seeded
    handshake(bridge, stranger.device) // the stranger still completes the salt exchange + arms

    const sid = stranger.device.nextStreamId()
    const open = stranger.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    bridge.onInbound(toArrayBuffer(open))

    await audit.flush()
    expect(dispatchCount).toBe(0)
    expect(audit.list().some((r) => r.action === 'reject')).toBe(true)
    // It must NOT have bridged anything.
    expect(audit.list().some((r) => r.action === 'http' && r.result === 'ok')).toBe(false)
  })

  it('an off-whitelist Open opens fine but is refused at the routing gate — Reset, no dispatch', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device) // arms + binds via the sealed Hello

    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/etc/passwd', headers: [], hasBody: false },
      }),
    })
    bridge.onInbound(toArrayBuffer(open))

    await audit.flush()
    expect(dispatchCount).toBe(0)
    // A Reset frame went back out (sealed), and a reject row names the whitelist reason.
    expect(outbound.length).toBeGreaterThan(0)
    expect(
      audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'path_not_whitelisted')
    ).toBe(true)
  })

  it('refuses a short/malformed frame before any open attempt', async () => {
    const session = createTestSession()
    const bridge = build(session.provider)
    // A 6-byte frame is shorter than the 12-byte header.
    bridge.onInbound(toArrayBuffer(new Uint8Array([REMOTE_CRYPTO_VERSION, 0, 0, 0, 0, 0])))
    await audit.flush()
    expect(dispatchCount).toBe(0)
    expect(audit.list().some((r) => r.action === 'reject')).toBe(true)
  })

  it('does not emit any outbound frame on a tamper (no streamId to trust for a Reset)', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device)
    outbound.length = 0 // drop the handshake's ConnSalt frames so we assert on the tamper alone
    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    const tampered = flipByte(new Uint8Array(open), open.length - 1)
    bridge.onInbound(toArrayBuffer(tampered))
    await audit.flush()
    // A frame that fails to open yields NO routing trust — we must not even Reset (we can't seal a
    // trustworthy Reset for an unauthenticated streamId). Just drop + audit.
    expect(outbound.length).toBe(0)
  })

  it('reattaches the WS query (clientId/cols/rows) onto the loopback URL — the separate meta field', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device) // arms + binds via the sealed Hello

    const sid = session.device.nextStreamId()
    // The phone sends a BARE whitelisted path + the query as separate StreamMeta.ws.query pairs.
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Ws,
        ws: {
          path: '/ws/terminal/run-9/io',
          query: [
            ['clientId', 'c1'],
            ['cols', '80'],
            ['rows', '24'],
          ],
        },
      }),
    })
    bridge.onInbound(toArrayBuffer(open))

    await audit.flush()
    // The io socket (and its companion control socket) dialed the loopback with the query reattached,
    // so terminal-ws-server reads clientId/cols/rows from url.searchParams. If the bridge dropped the
    // query, the PTY would never get the clientId/size — this is the read-from-searchParams contract.
    expect(wsOpenPaths.length).toBeGreaterThan(0)
    const io = wsOpenPaths.find((p) => p.startsWith('/ws/terminal/run-9/io'))
    expect(io).toBeDefined()
    const u = new URL(io ?? '', 'http://x')
    expect(u.pathname).toBe('/ws/terminal/run-9/io')
    expect(u.searchParams.get('clientId')).toBe('c1')
    expect(u.searchParams.get('cols')).toBe('80')
    expect(u.searchParams.get('rows')).toBe('24')
    // The companion control socket shares the SAME clientId (so its self-acks land on the same viewer).
    const control = wsOpenPaths.find((p) => p.startsWith('/ws/terminal/run-9/control'))
    expect(control).toBeDefined()
    expect(new URL(control ?? '', 'http://x').searchParams.get('clientId')).toBe('c1')
  })

  it('refuses a WS Open whose query is smuggled into the path — Reset, no dispatch', async () => {
    const session = createTestSession({ daemonId: DAEMON_ID })
    const bridge = build(session.provider)
    handshake(bridge, session.device) // arms + binds via the sealed Hello

    const sid = session.device.nextStreamId()
    const open = session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/terminal/run-9/io?clientId=c1' },
      }),
    })
    bridge.onInbound(toArrayBuffer(open))

    await audit.flush()
    expect(dispatchCount).toBe(0)
    expect(wsOpenPaths.length).toBe(0)
    expect(outbound.length).toBeGreaterThan(0) // a Reset went back
    expect(
      audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'path_not_canonical')
    ).toBe(true)
  })

  // H-NET-4 (single-daemon multi-device concurrency liveness) — two devices each legitimately
  // allocate the SAME odd streamId (createStreamIdAllocator('device') -> 1,3,5… per device). The
  // bridge bound streamOwner by streamId ALONE, so once device A held stream 1, device B's frame for
  // stream 1 was looked up against A's key, failed AEAD, and was dropped as open_failed — B's stream
  // was silently black-holed. The fix must trial-resolve a bound-but-non-opening frame against the
  // other candidates so B's stream 1 still dispatches.
  it('two devices reusing the same odd streamId both dispatch (no cross-device black-hole)', async () => {
    const a = createTestSession({ deviceId: 'device-A', daemonId: DAEMON_ID })
    const b = createTestSession({ deviceId: 'device-B', daemonId: DAEMON_ID })
    // One provider holds BOTH daemon-side sessions (the persistent provider's candidates() shape).
    const provider = new InMemoryDeviceSessionProvider()
    provider.set(a.daemonSession)
    provider.set(b.daemonSession)
    const bridge = build(provider)

    // Each device runs its OWN M6.1 channel handshake (its own phoneConnSalt; the daemon freezes each
    // device's connKeys at its bind, so the second handshake never desyncs the first — HARDEN major 4).
    handshake(bridge, a.device) // arms + binds A via its sealed Hello
    handshake(bridge, b.device) // arms + binds B via its sealed Hello

    // Both open GET /api/workspaces on their FIRST odd id (== 1).
    const sidA = a.device.nextStreamId()
    const sidB = b.device.nextStreamId()
    expect(sidA).toBe(sidB) // both legitimately allocate the same odd id

    const openOf = (s: ReturnType<typeof createTestSession>, sid: number): Uint8Array =>
      s.device.seal({
        kind: FrameKind.Open,
        streamId: sid,
        payload: encodeOpenPayload({
          transport: StreamTransport.Http,
          http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
        }),
      })

    bridge.onInbound(toArrayBuffer(openOf(a, sidA)))
    bridge.onInbound(toArrayBuffer(openOf(b, sidB)))

    await audit.flush()
    // BOTH opens reached the loopback dispatcher. Before the fix only A's did (B black-holed).
    expect(dispatchCount).toBe(2)
    // …and B was not mis-audited as a failed open.
    expect(
      audit.list().filter((r) => r.action === 'reject' && r.rejectReason === 'open_failed').length
    ).toBe(0)
  })

  // Header offsets must stay pinned to remote-crypto (defense against a silent layout drift).
  it('encodeHeader places streamId@4 and seq@8 (the AAD layout crypto reads)', () => {
    const h = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 0x01020304,
      seq: 0x0a0b0c0d,
    })
    expect([...h.slice(4, 8)]).toEqual([0x01, 0x02, 0x03, 0x04])
    expect([...h.slice(8, 12)]).toEqual([0x0a, 0x0b, 0x0c, 0x0d])
  })
})
