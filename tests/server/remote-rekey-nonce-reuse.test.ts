import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteAuditStore,
  type RemoteAuditStore,
} from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import { createFrameBridge, type FrameBridgeContext } from '../../src/server/remote-frame-bridge.js'
import {
  type BridgeContext,
  createRemoteTunnel,
  type FrameBridge,
  type RemoteTunnel,
} from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'
import {
  createMatchedRoots,
  createTestSession,
  type MatchedRoots,
} from '../helpers/remote-test-session.js'
import { createSealRecorder, type SealRecorder } from '../helpers/seal-recorder.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// M6.1 — daemon-side per-connection rekey, end-to-end. A REAL Hive runtime + a REAL `ws` fake gateway
// playing the phone with the REAL v2 channel handshake (UNSEALED bilateral ConnSalt exchange, sealed
// binding Hello under the per-connection key). No mocked PTY / socket / crypto.
//
// CENTERPIECE (B1): across a PAGE RELOAD (fresh phone mux + fresh daemon bridge over the SAME persisted
// device root) NO (key, nonce) tuple is ever reused — proven by a non-mocking recorder that observes
// the REAL key + REAL header of every seal on BOTH sides and recomputes the REAL nonce. On the pre-fix
// daemon (root used directly as the AEAD key) both connections seal the Hello under the same persisted
// root at nonce(dir, 0, 0) → a duplicate → this suite goes RED. The rekey makes it GREEN.

const TOKEN = 'daemon-token-rekey'

const waitFor = async (
  pred: () => boolean,
  timeoutMs = 4000,
  label = 'condition'
): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const td = new TextDecoder()

// A daemonId mismatch makes the sealed Hello/Open fail to open: the daemon drops them and can't seal a
// Reset for an unauthenticated stream, so openHttp never settles. Race it against a short timeout so a
// stalled (correctly-rejected) request surfaces as a rejection rather than hanging the suite.
const h6Request = (gateway: FakeGateway): Promise<unknown> =>
  Promise.race([
    gateway.openHttp({ method: 'GET', path: '/api/workspaces' }),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('request stalled — daemon never bound the device')), 2500)
    ),
  ])

const openHttpWithTimeout = (
  gateway: FakeGateway,
  req: { method: string; path: string },
  timeoutMs = 2500
) =>
  Promise.race([
    gateway.openHttp(req),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`request stalled: ${req.path}`)), timeoutMs)
    ),
  ])

interface Harness {
  server: Awaited<ReturnType<typeof startTestServer>>
  gateway: FakeGateway
  tunnel: RemoteTunnel
  audit: RemoteAuditStore
  recorder: SealRecorder
  provider: InMemoryDeviceSessionProvider
  cookie: string
  port: number
}

describe('remote tunnel — M6.1 daemon per-connection rekey (no (key,nonce) reuse)', () => {
  let harness: Harness | undefined
  let extra: Array<{ close: () => Promise<void> }> = []

  const auditDb = () => {
    const db = new Database(':memory:')
    applySchemaVersion23(db)
    return db
  }

  beforeEach(() => {
    harness = undefined
    extra = []
  })

  afterEach(async () => {
    for (const e of extra.splice(0)) await e.close()
    if (harness) {
      await harness.tunnel.close()
      await harness.gateway.close()
      await harness.server.close()
    }
    harness = undefined
  })

  // Boot a runtime + tunnel where BOTH sides feed the shared (key, nonce) recorder. The phone records
  // every p2d seal via createTestSession({ onSeal }); the daemon records every d2p seal via the
  // FrameBridgeContext.onSeal hook (a real observation, not a mock — sealNext still runs).
  const boot = async (opts: {
    recorder: SealRecorder
    provider?: InMemoryDeviceSessionProvider
    deviceId?: string
    daemonId?: string
    phoneSalts?: Uint8Array[]
    /**
     * Reuse a SPECIFIC persisted root across connections (the reload scenario). Both the phone peer and
     * the daemon session row are built from these exact bytes, so connection 2 is a fresh mux + fresh
     * bridge over the SAME root — not a freshly-minted random key. Without this, createTestSession mints
     * new random keys per boot and the per-connection keys diverge on the root, masking the very
     * nonce-reuse the regression must bite on.
     */
    roots?: MatchedRoots
  }): Promise<Harness> => {
    const server = await startTestServer()
    const cookie = await getUiCookie(server.baseUrl)
    const port = Number(new URL(server.baseUrl).port)
    const daemonId = opts.roots?.daemonId ?? opts.daemonId ?? 'daemon-rekey'

    // Deterministic-but-distinct phone salts if requested (B4 replay), else crypto random.
    let pi = 0
    const phoneGen = opts.phoneSalts
      ? () => {
          const s = opts.phoneSalts?.[pi] ?? opts.phoneSalts?.[opts.phoneSalts.length - 1]
          pi += 1
          if (!s) throw new Error('no phone salt')
          return Uint8Array.from(s)
        }
      : undefined

    const session = createTestSession({
      daemonId,
      ...(opts.roots ? { roots: opts.roots } : {}),
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(phoneGen ? { generateConnSalt: phoneGen } : {}),
      onSeal: (rec) =>
        opts.recorder.record({ key: rec.key, direction: 'p2d', headerBytes: rec.headerBytes }),
    })

    // Seed the daemon-side row. When roots are reused this writes the SAME bytes each connection
    // (idempotent), so the persisted daemon root is unchanged across the reload — connection 2 truly
    // re-keys over the one root rather than over a regenerated key.
    const provider = opts.provider ?? session.provider
    if (opts.provider) opts.provider.set(session.daemonSession)

    const gateway = await startFakeGateway({ expectedToken: TOKEN, device: session.device })
    const audit = createRemoteAuditStore(auditDb())

    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway.url,
      getDaemonToken: () => TOKEN,
      getDaemonId: () => daemonId,
    }

    const tunnel = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: provider,
      loopbackSecret: server.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
      // Same real bridge the tunnel ships; only the observation hook is injected.
      createBridge: (ctx) => createBridgeWithRecorder(ctx, opts.recorder),
    })
    tunnel.refresh()
    await waitFor(() => tunnel.status() === 'online', 4000, 'tunnel online')

    const h: Harness = {
      server,
      gateway,
      tunnel,
      audit,
      recorder: opts.recorder,
      provider: provider as InMemoryDeviceSessionProvider,
      cookie,
      port,
    }
    harness = h
    return h
  }

  it('(B1) page reload — fresh phone mux + fresh daemon bridge over ONE root — reuses no (key,nonce)', async () => {
    const recorder = createSealRecorder()
    const provider = new InMemoryDeviceSessionProvider()

    // Derive the persisted root ONCE so both connections are backed by the SAME device. This is the
    // whole point of the reload scenario: connection 2 must re-key over the persisted root, not over a
    // freshly-minted random key. (Previously boot() called createTestSession per connection, which
    // minted a NEW random root each time and overwrote the provider row — so the keys diverged on the
    // regenerated root, not on the salt, and the pre-fix nonce reuse was masked.)
    const roots = createMatchedRoots({ deviceId: 'device-reload', daemonId: 'daemon-reload' })

    // CONNECTION 1.
    const h = await boot({ recorder, provider, roots })
    const r1 = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(r1.status).toBe(200)

    // PAGE RELOAD: tear down BOTH the phone (gateway) and the daemon socket/bridge over the SAME root.
    await h.tunnel.close()
    await h.gateway.close()
    await h.server.close()
    harness = undefined

    // CONNECTION 2 — a brand-new phone mux + a brand-new daemon bridge over the SAME persisted root
    // (the provider keeps the same DeviceSession row, re-seeded with identical bytes). Fresh salts on
    // both sides ⇒ fresh connKeys.
    const h2 = await boot({ recorder, provider, roots })
    const r2 = await h2.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(r2.status).toBe(200)

    // The recorder saw seals on BOTH connections, both directions, including the two Hellos at (0,0).
    expect(recorder.count()).toBeGreaterThan(0)
    expect(recorder.dupes()).toBe(0)

    // Guard against a regenerated-root false pass: re-keying over the SAME root with fresh bilateral
    // salts must yield a DIFFERENT connKey per connection in each direction. On the pre-fix code (root
    // used directly) there is only ONE key per direction and the two reload Hellos collide at
    // nonce(dir, 0, 0), so dupes() bites; here we additionally pin that the rekey actually rotated the
    // key (≥2 distinct keys each way) rather than the root having quietly changed under us.
    expect(recorder.keys('p2d').length).toBeGreaterThanOrEqual(2)
    expect(recorder.keys('d2p').length).toBeGreaterThanOrEqual(2)
  }, 20000)

  it('(B2) the sealed Hello authenticates via trial-open — the right deviceId binds + serves', async () => {
    const recorder = createSealRecorder()
    const h = await boot({ recorder, deviceId: 'device-b2', daemonId: 'daemon-b2' })

    const res = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(res.status).toBe(200)

    await h.audit.flush()
    const row = h.audit.list().find((r) => r.action === 'http' && r.endpoint === '/api/workspaces')
    expect(row).toBeDefined()
    expect(row?.result).toBe('ok')
    expect(row?.deviceId).toBe('device-b2')
  }, 20000)

  it('(B3) a connection whose phone derived from device A binds A, never B (wrong root fails to open)', async () => {
    const recorder = createSealRecorder()
    const provider = new InMemoryDeviceSessionProvider()
    const daemonId = 'daemon-iso'

    // Two paired devices on ONE daemon. Boot drives device A's phone; device B is seeded as a foreign
    // candidate. A frame the daemon resolves must bind A (whose root reproduces A's connKey), not B.
    const sessionB = createTestSession({ daemonId, deviceId: 'device-B' })
    provider.set(sessionB.daemonSession)

    const h = await boot({ recorder, provider, deviceId: 'device-A', daemonId })
    const res = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(res.status).toBe(200)

    await h.audit.flush()
    const rows = h.audit
      .list()
      .filter((r) => r.action === 'http' && r.endpoint === '/api/workspaces')
    expect(rows.some((r) => r.deviceId === 'device-A')).toBe(true)
    expect(rows.some((r) => r.deviceId === 'device-B')).toBe(false)
  }, 20000)

  it('(B4) replaying the SAME phoneConnSalt across a reload still yields a distinct connKey', async () => {
    const recorder = createSealRecorder()
    const provider = new InMemoryDeviceSessionProvider()

    // One persisted root across both connections (same fix as B1): the reload must re-key over the SAME
    // root, otherwise a regenerated root would mask the reuse a pinned phone salt is meant to surface.
    const roots = createMatchedRoots({ deviceId: 'device-replay', daemonId: 'daemon-replay' })

    // Force the phone to use the SAME phoneConnSalt on BOTH connections (an attacker pinning its
    // contribution). The daemon's fresh daemonConnSalt per bridge must still make the connKey distinct,
    // so the two reload Hellos do NOT collide.
    const fixedSalt = new Uint8Array(32).fill(7)
    const phoneSalts = [Uint8Array.from(fixedSalt)]

    const h = await boot({ recorder, provider, roots, phoneSalts })
    const r1 = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(r1.status).toBe(200)

    await h.tunnel.close()
    await h.gateway.close()
    await h.server.close()
    harness = undefined

    const h2 = await boot({
      recorder,
      provider,
      roots,
      phoneSalts: [Uint8Array.from(fixedSalt)],
    })
    const r2 = await h2.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(r2.status).toBe(200)

    expect(recorder.count()).toBeGreaterThan(0)
    expect(recorder.dupes()).toBe(0)

    // Same root + same pinned phone salt across the reload, yet the daemon's fresh contribution must
    // still rotate the connKey each connection. ≥2 distinct keys each way proves the daemonConnSalt is
    // load-bearing; with the rekey removed this would collapse to one key per direction and bite above.
    expect(recorder.keys('p2d').length).toBeGreaterThanOrEqual(2)
    expect(recorder.keys('d2p').length).toBeGreaterThanOrEqual(2)
  }, 20000)

  it('(B6) a daemonId mismatch diverges the connKey — the Hello never opens, nothing binds', async () => {
    // The phone derives its connKeys with daemonId='daemon-true'; the DAEMON's bridge is configured
    // with a DIFFERENT daemonId, so its HKDF info diverges and it can't reproduce the phone's connKey.
    // The sealed Hello trial-opens against NO candidate → no device binds → the request never resolves.
    // This proves the daemonId is correctly threaded into the info binding and is load-bearing (HARDEN
    // minor): wire it wrong and EVERY Hello fails (total outage), exactly what this asserts can't pass.
    const server = await startTestServer()
    await getUiCookie(server.baseUrl)
    const port = Number(new URL(server.baseUrl).port)

    // Phone uses 'daemon-true'; the daemon config returns 'daemon-wrong'.
    const session = createTestSession({ daemonId: 'daemon-true', deviceId: 'device-b6' })
    const gateway = await startFakeGateway({ expectedToken: TOKEN, device: session.device })
    const audit = createRemoteAuditStore(auditDb())
    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway.url,
      getDaemonToken: () => TOKEN,
      getDaemonId: () => 'daemon-wrong',
    }
    const tunnel = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: session.provider,
      loopbackSecret: server.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
    })
    tunnel.refresh()
    await waitFor(() => tunnel.status() === 'online', 4000, 'tunnel online')
    extra.push({
      close: async () => {
        await tunnel.close()
        await gateway.close()
        await server.close()
      },
    })

    // The salt exchange is unsealed so the phone still arms; the SEALED Hello + GET, however, are sealed
    // under a connKey the daemon can't reproduce, so the request must NOT succeed (it rejects/stalls).
    await expect(h6Request(gateway)).rejects.toThrow()

    await audit.flush()
    // Nothing was ever bridged: no successful http row, and no device bound (the trial-open failed).
    expect(audit.list().some((r) => r.action === 'http' && r.result === 'ok')).toBe(false)
  }, 20000)

  it('(B5) daemon reconnect (same phone page) re-keys — no (key,nonce) reuse across the drop', async () => {
    const recorder = createSealRecorder()
    const h = await boot({ recorder, deviceId: 'device-b5', daemonId: 'daemon-b5' })

    const before = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(before.status).toBe(200)

    // Drop ONLY the daemon socket. The controller reconnects → a fresh bridge → attachSocket draws a
    // fresh daemonConnSalt; the phone (onSocket) begins a fresh channel with a fresh phoneConnSalt.
    // Wait for the gateway to accept a genuinely NEW daemon socket (count increases) — status alone is
    // racy because the old 'online' lingers until the close event propagates.
    const connsBefore = h.gateway.connectionCount()
    h.gateway.dropDaemon()
    await waitFor(
      () => h.gateway.connectionCount() > connsBefore,
      8000,
      'a fresh daemon socket reconnected'
    )
    await waitFor(() => h.tunnel.status() === 'online', 6000, 'tunnel reconnected')

    const after = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(after.status).toBe(200)
    expect(JSON.parse(td.decode(after.body))).toEqual(JSON.parse(td.decode(before.body)))

    expect(recorder.count()).toBeGreaterThan(0)
    expect(recorder.dupes()).toBe(0)
  }, 20000)

  it('(B7) same device can re-handshake on the same daemon socket with a new phone salt', async () => {
    const recorder = createSealRecorder()
    const h = await boot({ recorder, deviceId: 'device-b7', daemonId: 'daemon-b7' })

    const before = await openHttpWithTimeout(h.gateway, {
      method: 'GET',
      path: '/api/workspaces',
    })
    expect(before.status).toBe(200)

    // Mobile can rebuild its phone mux while the daemon's outbound socket stays up: visibility
    // recovery, a control-frame re-arm, or an in-app reload can all send a fresh phoneConnSalt over
    // the SAME daemon bridge. The bridge must replace this device's connKeys, not keep trying the
    // stale opener and audit open_failed forever.
    await h.gateway.rehandshakeDevice()

    const after = await openHttpWithTimeout(h.gateway, {
      method: 'GET',
      path: '/api/workspaces',
    })
    expect(after.status).toBe(200)
    expect(JSON.parse(td.decode(after.body))).toEqual(JSON.parse(td.decode(before.body)))

    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
    ).toBe(false)
  }, 20000)
})

// Build the real frame bridge but inject the daemon-side onSeal observation hook into its context. The
// real sealNext still runs — this only forwards (key, header) to the recorder (invariant: NOT a mock).
function createBridgeWithRecorder(ctx: BridgeContext, recorder: SealRecorder): FrameBridge {
  const fctx: FrameBridgeContext = {
    loopbackPort: ctx.loopbackPort,
    loopbackSecret: ctx.loopbackSecret,
    deviceSessions: ctx.deviceSessions,
    audit: ctx.audit,
    daemonId: ctx.daemonId,
    onSeal: (rec) =>
      recorder.record({ key: rec.key, direction: rec.direction, headerBytes: rec.headerBytes }),
  }
  return createFrameBridge(fctx)
}
