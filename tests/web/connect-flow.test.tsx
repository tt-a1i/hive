// @vitest-environment jsdom
//
// M5a STAGE 5 — the ConnectView data/flow layer (web). These tests pin the behavior M5b will skin:
//   - login redirect when the gateway session is missing (401 on /pair/machines)
//   - machine-list fetch + online status surfaced verbatim
//   - select a PAIRED daemon (store has a record for THIS daemon) -> transport built, no pairing
//   - select an UNPAIRED daemon (no store record for THIS daemon) -> pairing client started
//   - HARDEN minor: the "skip pairing" shortcut is gated per-daemon (store.load(gw, id)), NOT on the
//     account-wide self.deviceId — a phone paired to daemon A still needs a fresh pairing for daemon B.
//
// The flow holds no crypto: building the TunnelTransport is an injected dep (connectTransport) so the
// genuinely-deferred silent-rebuild key question (pairingSecret is never persisted, §4.1/§9) stays out
// of this layer. The tests inject fakes for the gateway fetch, the redirect, the pairing client, and
// connectTransport, and assert the orchestration is correct.

import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { encodePairingPayload, REMOTE_CRYPTO_VERSION } from '../../src/shared/remote-crypto.js'
import { type ConnectResult, createConnectFlow } from '../../web/src/connect/connect-flow.js'
import type {
  DeviceSessionStore,
  StoredDeviceSession,
} from '../../web/src/transport/device-session-store.js'
import type {
  PairingClient,
  PairingClientEvents,
  PairingResult,
} from '../../web/src/transport/pairing-client.js'

const GATEWAY = 'https://app.hivehq.dev'

const QR = encodePairingPayload({
  v: REMOTE_CRYPTO_VERSION,
  gatewayUrl: 'wss://app.hivehq.dev/relay',
  daemonId: 'daemon-b',
  pairingSecret: 'c2VjcmV0LXBhaXJpbmctMzJieXRlcy12YWx1ZS14eA',
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const storedRecord = (gatewayUrl: string, daemonId: string): StoredDeviceSession => ({
  v: 2,
  gatewayUrl,
  daemonId,
  deviceId: `device-for-${daemonId}`,
  deviceKeyPair: { secretKey: 'c2s', publicKey: 'cGs' },
  daemonPublicKey: 'ZHBr',
  rootKeys: { d2p: 'cm9vdC1kMnA', p2d: 'cm9vdC1wMmQ' },
  protocolVersion: REMOTE_CRYPTO_VERSION,
  pairedAt: 1,
})

// An in-memory store the flow consults to decide paired-vs-unpaired PER DAEMON.
const makeStore = (records: StoredDeviceSession[] = []): DeviceSessionStore => {
  const map = new Map<string, StoredDeviceSession>()
  for (const r of records) map.set(`${r.gatewayUrl}:${r.daemonId}`, r)
  return {
    load: (gw, id) => map.get(`${gw}:${id}`) ?? null,
    save: (rec) => {
      map.set(`${rec.gatewayUrl}:${rec.daemonId}`, rec)
    },
    clear: (gw, id) => {
      map.delete(`${gw}:${id}`)
    },
  }
}

// A scripted pairing client: start() resolves with whatever the test queued, and onPhase/onSas fire
// so the flow can surface them. It mirrors createPairingClient's contract without the real ceremony.
const makeFakePairing = (
  result: PairingResult
): {
  create: (qr: string, events: PairingClientEvents) => PairingClient
  createdWith: string[]
} => {
  const createdWith: string[] = []
  return {
    createdWith,
    create: (qr, events) => {
      createdWith.push(qr)
      const client: PairingClient = {
        phase: 'idle',
        sas: null,
        deviceId: result.ok ? result.deviceId : null,
        start: async () => {
          events.onPhase('connecting')
          if (result.ok) {
            events.onSas('123456')
            events.onPhase('paired')
          } else {
            events.onFailure(result.failure)
          }
          return result
        },
        cancel: () => {},
        dispose: () => {},
      }
      return client
    },
  }
}

beforeEach(() => {
  // jsdom defaults the location to localhost; the flow reads the configured gateway base, not window.
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('connect-flow login + machines', () => {
  test('loadMachines redirects to the gateway OAuth entry when the session is missing (401)', async () => {
    const redirected: string[] = []
    const fetchImpl = vi.fn(async () => json({ error: 'unauthorized' }, 401))
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redirect: (url) => redirected.push(url),
      connectTransport: async () => ({ ok: true }),
    })

    await flow.loadMachines().catch(() => {
      // a redirect short-circuits the load; either resolution shape is fine, the redirect is the point
    })

    expect(redirected.length).toBe(1)
    expect(redirected[0]).toContain('/auth/')
    // it must come back to the connect view after OAuth
    expect(redirected[0]).toContain('redirect=')
    expect(flow.phase).toBe('login')
  })

  test('loadMachines(provider) bounces through the CHOSEN OAuth entry (Google → Google, not the github default)', async () => {
    // REGRESSION: authProvider was fixed at construction and the chosen provider was dropped, so
    // "Continue with Google" silently used /auth/github. The arg must select the OAuth entry.
    const redirected: string[] = []
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: (async () => json({ error: 'unauthorized' }, 401)) as unknown as typeof fetch,
      redirect: (url) => redirected.push(url),
      connectTransport: async () => ({ ok: true }),
      // no authProvider override → constructor default is 'github'; the explicit arg must win
    })

    await flow.loadMachines('google').catch(() => {})
    expect(redirected[0]).toContain('/auth/google')
    expect(redirected[0]).not.toContain('/auth/github')

    await flow.loadMachines('github').catch(() => {})
    expect(redirected[1]).toContain('/auth/github')
  })

  test('loadMachines returns the daemon list with online status and selfDeviceId', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(url).toContain('/pair/machines')
      return json({
        daemons: [
          { id: 'daemon-a', name: 'Studio', lastSeen: 111, revoked: false, online: true },
          { id: 'daemon-b', name: 'Laptop', lastSeen: 222, revoked: false, online: false },
        ],
        self: { deviceId: null },
      })
    })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redirect: () => {},
      connectTransport: async () => ({ ok: true }),
    })

    const { daemons, selfDeviceId } = await flow.loadMachines()

    expect(selfDeviceId).toBeNull()
    expect(daemons.map((d) => d.id)).toEqual(['daemon-a', 'daemon-b'])
    expect(daemons[0]?.online).toBe(true)
    expect(daemons[1]?.online).toBe(false)
    expect(daemons[0]?.name).toBe('Studio')
    expect(flow.phase).toBe('machines')
    // /pair/machines is a gateway-origin cookie-authed call, NOT the tunnelled /api — credentials ride.
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.credentials).toBe('include')
  })
})

describe('connect-flow selectDaemon', () => {
  test('selecting a PAIRED daemon keeps the machine list visible while silent reconnect is pending', async () => {
    const phases: string[] = []
    const connectCalls: string[] = []
    const transportCompletion: { resolve?: (result: ConnectResult) => void } = {}
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-a' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore([storedRecord(GATEWAY, 'daemon-a')]),
      fetchImpl: (async () =>
        json({
          daemons: [
            { id: 'daemon-a', name: 'Studio', lastSeen: 111, revoked: false, online: true },
          ],
          self: { deviceId: 'device-for-daemon-a' },
        })) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return new Promise((resolve) => {
          transportCompletion.resolve = resolve
        })
      },
      onPhase: (p) => phases.push(p),
    })

    await flow.loadMachines()
    expect(flow.phase).toBe('machines')
    phases.length = 0

    const pending = flow.selectDaemon('daemon-a')

    expect(connectCalls).toEqual(['daemon-a'])
    expect(flow.phase).toBe('machines')
    expect(phases).not.toContain('selecting')
    expect(fakePairing.createdWith).toEqual([])

    if (!transportCompletion.resolve) throw new Error('Expected pending transport')
    transportCompletion.resolve({ ok: true })
    const result = await pending

    expect(result.ok).toBe(true)
    expect(flow.phase).toBe('connected')
    expect(phases).toEqual(['connected'])
  })

  test('selecting a PAIRED daemon (store has a record for it) builds the transport, no pairing', async () => {
    const connectCalls: string[] = []
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-a' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore([storedRecord(GATEWAY, 'daemon-a')]),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    const result = await flow.selectDaemon('daemon-a')

    expect(result.ok).toBe(true)
    expect(connectCalls).toEqual(['daemon-a'])
    expect(fakePairing.createdWith).toEqual([]) // no pairing ceremony for an already-paired daemon
    expect(flow.pairingClient).toBeNull()
    expect(flow.phase).toBe('connected')
  })

  test('a failed silent reconnect moves to the pairing guide so the user can enter a fresh code', async () => {
    const phases: string[] = []
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-a' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore([storedRecord(GATEWAY, 'daemon-a')]),
      fetchImpl: (async () =>
        json({
          daemons: [
            { id: 'daemon-a', name: 'Studio', lastSeen: 111, revoked: false, online: true },
          ],
          self: { deviceId: 'device-for-daemon-a' },
        })) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async () => ({
        ok: false,
        failure: { code: 'select_failed', message: 'stale session' },
      }),
      onPhase: (p) => phases.push(p),
    })

    await flow.loadMachines()
    phases.length = 0

    const result = await flow.selectDaemon('daemon-a')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('select_failed')
    expect(flow.phase).toBe('selecting')
    expect(phases).toEqual(['selecting'])
    expect(fakePairing.createdWith).toEqual([])
    expect(flow.pairingClient).toBeNull()
  })

  test('an explicit QR re-pairs even when a stored record exists (heals an orphaned/stale session)', async () => {
    // REGRESSION: selectDaemon silently reused ANY stored record, so a phone holding a stale/orphaned
    // session (daemon has no matching device → rejects every frame → "could not reach runtime") could
    // NEVER recover by re-scanning — the dead session short-circuited the ceremony. A scanned QR is an
    // explicit "pair me now" and must run the ceremony, overwriting the bad record.
    const connectCalls: string[] = []
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'fresh-device-for-daemon-a' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore([storedRecord(GATEWAY, 'daemon-a')]), // a stored (possibly stale) record exists
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    const result = await flow.selectDaemon('daemon-a', QR)

    expect(result.ok).toBe(true)
    // It RAN the pairing ceremony with the scanned QR rather than silently reusing the stored record.
    expect(fakePairing.createdWith).toEqual([QR])
    expect(flow.pairingClient).not.toBeNull()
    expect(connectCalls).toEqual(['daemon-a'])
  })

  test('a successful pairing whose tunnel cannot open returns to the pairing guide with a connect error', async () => {
    const phases: string[] = []
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-b' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async () => ({
        ok: false,
        failure: { code: 'select_failed', message: 'tunnel ready timed out' },
      }),
      onPhase: (p) => phases.push(p),
    })

    const result = await flow.selectDaemon('daemon-b', QR)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('select_failed')
    expect(fakePairing.createdWith).toEqual([QR])
    expect(flow.phase).toBe('selecting')
    expect(phases).toEqual(['selecting', 'pairing', 'selecting'])
  })

  test('selecting an UNPAIRED daemon runs the pairing client, then builds the transport on success', async () => {
    const connectCalls: string[] = []
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-b' })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(), // no record for daemon-b -> must pair
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    const result = await flow.selectDaemon('daemon-b', QR)

    expect(result.ok).toBe(true)
    expect(fakePairing.createdWith).toEqual([QR]) // pairing ran with the scanned QR
    expect(flow.pairingClient).not.toBeNull() // surfaced for M5b to render SAS/phase
    expect(connectCalls).toEqual(['daemon-b']) // transport built only AFTER pairing succeeded
    expect(flow.phase).toBe('connected')
  })

  test('selecting an UNPAIRED daemon without a QR returns needs_pairing (the guide), not a connect error', async () => {
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'x' })
    const connectCalls: string[] = []
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    const result = await flow.selectDaemon('daemon-b')

    expect(result.ok).toBe(false)
    // needs_pairing (benign — the flow moved to the pairing guide), NOT select_failed (a real connect
    // error). The mobile entry shows a failure banner only for the latter.
    if (!result.ok) expect(result.failure.code).toBe('needs_pairing')
    expect(flow.phase).toBe('selecting')
    expect(fakePairing.createdWith).toEqual([])
    expect(connectCalls).toEqual([]) // no transport built without a session
    expect(flow.phase).not.toBe('connected')
  })

  test('HARDEN minor: a phone paired to daemon A still pairs for daemon B (self.deviceId is not account-wide)', async () => {
    // store has a record for daemon-a but NOT daemon-b. self.deviceId is non-null (paired to A).
    const fakePairing = makeFakePairing({ ok: true, deviceId: 'device-for-daemon-b' })
    const connectCalls: string[] = []
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore([storedRecord(GATEWAY, 'daemon-a')]),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    // selecting daemon-b (paired to A, no key material for B) MUST run a fresh pairing.
    const result = await flow.selectDaemon('daemon-b', QR)

    expect(result.ok).toBe(true)
    expect(fakePairing.createdWith).toEqual([QR]) // a fresh pairing for B despite being paired to A
    expect(connectCalls).toEqual(['daemon-b'])
  })

  test('a failed pairing surfaces the failure and does NOT build the transport', async () => {
    const connectCalls: string[] = []
    const pairingFailures: string[] = []
    const fakePairing = makeFakePairing({
      ok: false,
      failure: { code: 'mint_forbidden', message: 'not confirmed' },
    })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: fakePairing.create,
      onPairingFailure: (failure) => pairingFailures.push(failure.code),
      connectTransport: async ({ daemonId }) => {
        connectCalls.push(daemonId)
        return { ok: true }
      },
    })

    const result = await flow.selectDaemon('daemon-b', QR)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('mint_forbidden')
    expect(pairingFailures).toEqual(['mint_forbidden'])
    expect(connectCalls).toEqual([]) // a failed pairing never hands a phone a transport (invariant 2)
    expect(flow.phase).not.toBe('connected')
  })

  test('phase transitions through selecting -> pairing during an unpaired select', async () => {
    const phases: string[] = []
    const pairingCompletion: { resolve?: (result: PairingResult) => void } = {}
    const create = (_qr: string, events: PairingClientEvents): PairingClient => ({
      phase: 'idle',
      sas: null,
      deviceId: null,
      start: () =>
        new Promise<PairingResult>((res) => {
          events.onPhase('connecting')
          pairingCompletion.resolve = res
        }),
      cancel: () => {},
      dispose: () => {},
    })
    const flow = createConnectFlow({
      gatewayBaseUrl: GATEWAY,
      store: makeStore(),
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
      redirect: () => {},
      createPairing: create,
      connectTransport: async () => ({ ok: true }),
      onPhase: (p) => phases.push(p),
    })

    const pending = flow.selectDaemon('daemon-b', QR)
    // by now the flow has entered the pairing phase and exposed the client
    expect(flow.phase).toBe('pairing')
    expect(flow.pairingClient).not.toBeNull()
    if (!pairingCompletion.resolve) throw new Error('Expected pending pairing')
    pairingCompletion.resolve({ ok: true, deviceId: 'device-for-daemon-b' })
    await pending

    expect(phases).toContain('selecting')
    expect(phases).toContain('pairing')
    expect(phases).toContain('connected')
  })
})
