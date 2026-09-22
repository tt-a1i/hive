// ConnectView data/flow layer (M5a STAGE 5). NO JSX — this is the state machine the M5b ConnectView
// renders. It orchestrates the phone's path to a live tunnel:
//
//   login → machines → connected (stored silent reconnect)
//                    ↘ selecting → pairing → connected
//
//   - login:    no gateway session (a 401 on /pair/machines) → redirect to the gateway OAuth entry,
//               coming back to the connect view. The gateway sets hive_gw_session (browser-login,
//               deviceId=null) on return.
//   - machines: GET /pair/machines (gateway origin, cookie-authed — NOT the tunnelled /api). Surfaces
//               each daemon + its `online` status + this session's self.deviceId.
//   - selecting→pairing: the user picks a daemon. The "skip pairing" shortcut is gated PER DAEMON on
//               store.load(gatewayUrl, daemonId) — NOT on the account-wide self.deviceId (HARDEN
//               minor): a phone paired to daemon A holds no key material for daemon B, so selecting B
//               needs a fresh pairing (a new device row + new bound keys) even though self.deviceId!==
//               null. If a store record exists for THIS daemon → silent reconnect, no pairing client.
//               Else a QR is required → createPairingClient runs; the client is surfaced for M5b to
//               render onPhase/onSas/onFailure.
//   - connected: on a store record (or a freshly-paired device) → connectTransport builds the
//               TunnelTransport and swaps it in via setApiTransport, then the React app mounts.
//
// This layer holds NO crypto. Building the TunnelTransport (including the genuinely-deferred
// silent-rebuild key derivation — the pairingSecret is never persisted, see device-session-store §4.1
// and the spec §9) is an injected `connectTransport` dependency. The flow's only job is orchestration.

import type { DeviceSessionStore, StoredDeviceSession } from '../transport/device-session-store.js'
import {
  createPairingClient,
  type PairingClient,
  type PairingClientEvents,
  type PairingFailure,
  type PairingPhase,
} from '../transport/pairing-client.js'

export type ConnectPhase = 'login' | 'machines' | 'selecting' | 'pairing' | 'connected'

export interface MachineView {
  id: string
  name: string
  lastSeen: number | null
  revoked: boolean
  online: boolean
}

// 'select_failed' = a session that SHOULD work didn't (reconnect of a stored device session failed:
// stale/revoked session, daemon offline, tunnel-ready timeout) — a real error the UI must surface.
// 'relay_revoked' = relay-token 403 — the daemon revoked this device's session; stored record cleared.
// 'needs_pairing' = no stored session for this daemon and no QR yet — NOT an error, the flow just moves
// to the pairing guide. Kept distinct so the mobile entry only shows a failure banner for the former.
export type SelectFailure =
  | PairingFailure
  | { code: 'select_failed' | 'relay_revoked' | 'needs_pairing'; message: string }
export type ConnectResult = { ok: true } | { ok: false; failure: SelectFailure }

interface MachinesPayload {
  daemons: Array<{
    id: string
    name: string
    lastSeen: number | null
    revoked: boolean
    online: boolean
  }>
  self: { deviceId: string | null }
}

export interface ConnectFlowDeps {
  /** localStorage-backed device session store; gates the per-daemon "skip pairing" shortcut. */
  store: DeviceSessionStore
  /** Gateway HTTPS origin for /pair/* + /auth/*. Defaults to window.location.origin. */
  gatewayBaseUrl?: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Navigate the browser (OAuth redirect). Defaults to window.location.assign. */
  redirect?: (url: string) => void
  /** OAuth provider path segment under /auth. Defaults to 'github'. */
  authProvider?: 'github' | 'google'
  /** Builds the TunnelTransport for a (paired or freshly-paired) daemon and swaps it in. Injected so
   *  this flow stays crypto-free; the entry/M5b supplies the real implementation. */
  connectTransport: (input: {
    daemonId: string
    deviceId: string
    stored: StoredDeviceSession | null
  }) => Promise<ConnectResult>
  /** Injected for tests; defaults to createPairingClient. */
  createPairing?: (
    qrPayload: string,
    events: PairingClientEvents,
    deps: Parameters<typeof createPairingClient>[2]
  ) => PairingClient
  /** Phone's unpaired gateway-session jti, bound into the pairing to close a concurrent race. */
  boundJti?: string
  /** Optional name proposed for the device row during pairing. */
  proposedName?: string
  /** Default mintSession passed to the pairing client (POST /pair/session). Injected for tests. */
  mintSession?: (gatewayUrl: string, body: { daemonId: string; deviceId: string }) => Promise<void>
  /** Notified on every phase transition (M5b drives its view off this; tests assert the sequence). */
  onPhase?: (phase: ConnectPhase) => void
  /** Surfaced pairing sub-state for M5b's SAS/phase rendering. */
  onPairingPhase?: (phase: PairingPhase) => void
  onPairingSas?: (sas: string) => void
  /** Surfaced terminal pairing failure for localized mobile copy. */
  onPairingFailure?: (failure: PairingFailure) => void
}

export interface ConnectFlow {
  readonly phase: ConnectPhase
  /** `provider` selects which OAuth entry the login bounce uses; it sticks for later calls. Omitting it
   *  keeps the current provider (the constructor default on first call). */
  loadMachines(provider?: 'github' | 'google'): Promise<{
    daemons: MachineView[]
    selfDeviceId: string | null
  }>
  selectDaemon(daemonId: string, qrPayload?: string): Promise<ConnectResult>
  /** Surfaced for M5b to render the SAS/phase while pairing; null outside a pairing ceremony. */
  pairingClient: PairingClient | null
}

const DEFAULT_MINT =
  (fetchImpl: typeof fetch) =>
  async (gatewayUrl: string, body: { daemonId: string; deviceId: string }): Promise<void> => {
    const res = await fetchImpl(`${gatewayUrl}/pair/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // Reject WITH .status so the pairing client maps a 403 → mint_forbidden (invariant 2).
      throw Object.assign(new Error(`mint failed: ${res.status}`), { status: res.status })
    }
  }

export function createConnectFlow(deps: ConnectFlowDeps): ConnectFlow {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const gatewayBaseUrl = deps.gatewayBaseUrl ?? window.location.origin
  const redirect = deps.redirect ?? ((url: string) => window.location.assign(url))
  const createPairing = deps.createPairing ?? createPairingClient
  const mintSession = deps.mintSession ?? DEFAULT_MINT(fetchImpl)
  // Mutable: the login screen picks the provider per click (onSelectProvider → loadMachines(provider)).
  // A const here is the bug where "Continue with Google" silently bounced through GitHub.
  let authProvider: 'github' | 'google' = deps.authProvider ?? 'github'

  let phase: ConnectPhase = 'login'
  let pairingClient: PairingClient | null = null

  const setPhase = (next: ConnectPhase): void => {
    phase = next
    deps.onPhase?.(next)
  }

  // The pairing channel uses the daemon gateway URL carried in the QR; the pairing client normalizes
  // it to ws(s) for /relay/pair. The store record's gatewayUrl is the value the pairing client
  // persisted; we key the per-daemon store lookup on the SAME gatewayBaseUrl the device-session-store
  // was seeded with.
  const storedFor = (daemonId: string): StoredDeviceSession | null =>
    deps.store.load(gatewayBaseUrl, daemonId)

  const loadMachines = async (
    provider?: 'github' | 'google'
  ): Promise<{
    daemons: MachineView[]
    selfDeviceId: string | null
  }> => {
    if (provider) authProvider = provider
    const res = await fetchImpl(`${gatewayBaseUrl}/pair/machines`, {
      credentials: 'include',
    })
    if (res.status === 401) {
      // No gateway session → bounce through OAuth, returning to the connect view.
      const back = encodeURIComponent(window.location.pathname + window.location.search)
      setPhase('login')
      redirect(`${gatewayBaseUrl}/auth/${authProvider}?redirect=${back}`)
      return { daemons: [], selfDeviceId: null }
    }
    if (!res.ok) {
      throw new Error(`Failed to load machines: ${res.status}`)
    }
    const payload = (await res.json()) as MachinesPayload
    const daemons: MachineView[] = payload.daemons.map((d) => ({
      id: d.id,
      name: d.name,
      lastSeen: d.lastSeen,
      revoked: d.revoked,
      online: d.online,
    }))
    setPhase('machines')
    return { daemons, selfDeviceId: payload.self.deviceId }
  }

  // The pairing payload carries daemonId + gateway URL + the pairing secret. New mobile UI derives
  // that payload from a human pairing code; old deeplink/raw-payload inputs still feed this path.
  const runPairing = (qrPayload: string): ReturnType<PairingClient['start']> => {
    setPhase('pairing')
    const events: PairingClientEvents = {
      onPhase: (p) => deps.onPairingPhase?.(p),
      onSas: (s) => deps.onPairingSas?.(s),
      onFailure: (failure) => deps.onPairingFailure?.(failure),
    }
    const client = createPairing(qrPayload, events, {
      openSocket: (url, protocols) =>
        new WebSocket(url, protocols) as unknown as ReturnType<
          Parameters<typeof createPairingClient>[2]['openSocket']
        >,
      store: deps.store,
      mintSession,
      ...(deps.proposedName ? { proposedName: deps.proposedName } : {}),
      ...(deps.boundJti ? { boundJti: deps.boundJti } : {}),
    })
    pairingClient = client
    return client.start()
  }

  const selectDaemon = async (daemonId: string, qrPayload?: string): Promise<ConnectResult> => {
    pairingClient = null

    const existing = storedFor(daemonId)

    // SILENT RECONNECT only when there is NO explicit QR — a stored record means a returning device
    // (HARDEN minor: keyed on the per-daemon store record, never the account-wide self.deviceId). But a
    // Pairing payload is an explicit "pair me now": the user entered a fresh code, so we MUST run the
    // ceremony instead of silently reusing a stored session. Otherwise a stale/orphaned record (daemon
    // revoked it, or a half-finished pairing the daemon never recorded) strands the phone reconnecting
    // to a session the daemon rejects, with NO way to recover by re-pairing. A fresh pairing overwrites the
    // record under the same key, so an explicit re-scan self-heals.
    if (existing && !qrPayload) {
      const result = await deps.connectTransport({
        daemonId,
        deviceId: existing.deviceId,
        stored: existing,
      })
      if (result.ok) {
        setPhase('connected')
        return result
      }
      // relay_revoked: the daemon revoked this device. Clear the stale record so the next attempt
      // starts clean (no orphaned session) and the user lands on the pairing guide.
      if (!result.ok && result.failure.code === 'relay_revoked') {
        deps.store.clear(gatewayBaseUrl, daemonId)
      }
      setPhase('selecting')
      return result
    }

    setPhase('selecting')

    // No stored record (or an explicit re-pair) → a pairing payload is required to run the ceremony.
    // This is NOT a failure to surface: we've already moved to 'selecting' (the pairing guide), so the
    // code is 'needs_pairing' (benign) rather than 'select_failed' (a real connect error).
    if (!qrPayload) {
      return {
        ok: false,
        failure: {
          code: 'needs_pairing',
          message: 'this device is not paired with that computer — enter its pairing code first',
        },
      }
    }

    const pairResult = await runPairing(qrPayload)
    if (!pairResult.ok) {
      // A failed pairing never hands the phone a transport (invariant 2: no confirm → no session).
      return pairResult
    }

    // Pairing persisted the durable identity; build the transport from it.
    const stored = storedFor(daemonId)
    const result = await deps.connectTransport({
      daemonId,
      deviceId: pairResult.deviceId,
      stored,
    })
    if (result.ok) {
      setPhase('connected')
      return result
    }
    if (result.failure.code === 'relay_revoked') {
      deps.store.clear(gatewayBaseUrl, daemonId)
    }
    setPhase('selecting')
    return result
  }

  return {
    get phase() {
      return phase
    },
    get pairingClient() {
      return pairingClient
    },
    loadMachines,
    selectDaemon,
  }
}
