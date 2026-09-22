import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteAuditStore,
  type RemoteAuditStore,
} from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { createRemoteTunnel, type RemoteTunnel } from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'
import { createTestSession } from '../helpers/remote-test-session.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// END-TO-END bridge tests: a REAL Hive runtime (startTestServer) + a REAL `ws` fake gateway that
// plays the phone using the REAL M1 crypto. A frame the phone seals travels the gateway socket,
// the daemon OPENS it, the bridge runs it against the live 127.0.0.1 runtime, and the sealed
// response comes back to the phone. No mocked PTY, no mocked socket, no mocked crypto.

const TOKEN = 'daemon-token-bridge'

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

interface Harness {
  server: Awaited<ReturnType<typeof startTestServer>>
  gateway: FakeGateway
  tunnel: RemoteTunnel
  session: ReturnType<typeof createTestSession>
  audit: RemoteAuditStore
  cookie: string
  port: number
}

describe('remote tunnel — E2E bridge over a real runtime', () => {
  const tempDirs: string[] = []
  let harness: Harness | undefined

  const auditDb = () => {
    const db = new Database(':memory:')
    applySchemaVersion23(db)
    return db
  }

  beforeEach(() => {
    harness = undefined
  })

  afterEach(async () => {
    if (harness) {
      await harness.tunnel.close()
      await harness.gateway.close()
      await harness.server.close()
    }
    harness = undefined
    for (const d of tempDirs.splice(0)) rmSync(d, { force: true, recursive: true })
  })

  const boot = async (): Promise<Harness> => {
    const server = await startTestServer()
    const cookie = await getUiCookie(server.baseUrl)
    const port = Number(new URL(server.baseUrl).port)
    const session = createTestSession()
    const gateway = await startFakeGateway({ expectedToken: TOKEN, device: session.device })

    const db = auditDb()
    const audit = createRemoteAuditStore(db)

    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway.url,
      getDaemonToken: () => TOKEN,
      getDaemonId: () => session.daemonId,
    }

    const tunnel = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: session.provider,
      // CRITICAL: the bridge must present the runtime's live per-boot secret, so loopback requests
      // are authorized as tunnel-originated (invariant 2). Reading the wrong/absent secret => 403.
      loopbackSecret: server.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
    })
    tunnel.refresh()
    await waitFor(() => tunnel.status() === 'online', 4000, 'tunnel online')
    // Relay connectivity precedes the device's connection-key handshake.
    // Raw-frame scenarios call seal directly instead of openHttp's readiness gate.
    await waitFor(() => session.device.armed(), 4000, 'device channel armed')

    const h: Harness = { server, gateway, tunnel, session, audit, cookie, port }
    harness = h
    return h
  }

  const seedWorkspace = async (h: Harness, path: string): Promise<{ id: string }> => {
    const res = await fetch(`${h.server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path }),
    })
    return (await res.json()) as { id: string }
  }

  it('(a) GET /api/workspaces over the tunnel equals the direct cookie result + tags the request', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-ws-'))
    tempDirs.push(wsPath)
    await seedWorkspace(h, wsPath)

    // Direct (cookie) result.
    const direct = await fetch(`${h.server.baseUrl}/api/workspaces`, {
      headers: { cookie: h.cookie },
    })
    const directBody = await direct.json()

    // Over the tunnel.
    const tunneled = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(tunneled.status).toBe(200)
    const tunneledBody = JSON.parse(td.decode(tunneled.body))
    expect(tunneledBody).toEqual(directBody)

    // The loopback request was tagged remote for the resolved device (proven via the audit row,
    // not a mock): an http/ok row with endpoint=/api/workspaces and deviceId set.
    await h.audit.flush()
    const row = h.audit.list().find((r) => r.action === 'http' && r.endpoint === '/api/workspaces')
    expect(row).toBeDefined()
    expect(row?.result).toBe('ok')
    expect(row?.deviceId).toBe(h.session.deviceId)

    // Invariant 2 defense: the per-boot secret must NEVER appear in any audit row (never logged).
    const secret = h.server.store.getRemoteTunnelSecret()
    const serialized = JSON.stringify(h.audit.list())
    expect(serialized.includes(secret)).toBe(false)

    // Invariant 2 (response side): no Set-Cookie / x-hive-* header crossed back to the phone.
    const headerNames = tunneled.headers.map(([n]) => n.toLowerCase())
    expect(headerNames.some((n) => n === 'set-cookie' || n.startsWith('x-hive-'))).toBe(false)
  })

  it('(a3) VULN-LOOPBACK-1: phone-supplied Host/Origin/Cookie never reach the loopback request', async () => {
    const h = await boot()
    // The phone fully controls the Open meta header list. Smuggle a non-local Host + Origin and a
    // guessed UI cookie. Before the request-side sanitizer these flowed verbatim onto the 127.0.0.1
    // request, and the daemon's fail-closed assertLocalRequest 403s its OWN tunneled request on the
    // 'Host: evil.com' (a phone-driven self-DoS). After the fix the smuggled headers are dropped and
    // the request reaches the route normally.
    const tunneled = await h.gateway.openHttp({
      method: 'GET',
      path: '/api/workspaces',
      headers: [
        ['Host', 'evil.com'],
        ['Origin', 'http://evil.com'],
        ['Cookie', 'hive_ui_token=guess'],
      ],
    })
    // Reached the route (200), NOT a 403 from the local-request guard tripping on a smuggled Host.
    expect(tunneled.status).toBe(200)
  })

  it('(a2) a query-bearing /api route round-trips over the tunnel (canonicalization allows ?query)', async () => {
    const h = await boot()
    // /api/fs/browse?path=... reads a query param. The whitelist must allow a ?query (a literal path
    // value; encoded slashes/dots are still refused by canonicalization, which is intended).
    const res = await h.gateway.openHttp({
      method: 'GET',
      path: '/api/fs/browse?path=/tmp',
    })
    // The route exists and was reached over the tunnel (200 or a structured error, never a refuse).
    expect([200, 400, 404]).toContain(res.status)
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint?.startsWith('/api/fs/browse'))
    ).toBe(true)
  })

  it('(a4) POST /api/team/recall round-trips over the E2E relay to the runtime', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-recall-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)
    const orchestratorId = `${workspace.id}:orchestrator`
    await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        body: JSON.stringify({
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
        }),
      }
    )
    const startResponse = await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        body: JSON.stringify({ hive_port: String(h.port) }),
      }
    )
    expect(startResponse.status).toBe(201)
    const token = h.server.store.peekAgentToken(orchestratorId)
    if (!token) throw new Error('Expected orchestrator token after start')

    h.server.store.recordUserInput(workspace.id, orchestratorId, '手机端 recall 验证：远程访问链路')

    const res = await h.gateway.openHttp({
      method: 'POST',
      path: '/api/team/recall',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          query: '访问链',
          limit: 3,
          window: 1,
        })
      ),
    })

    expect(res.status).toBe(200)
    const payload = JSON.parse(td.decode(res.body)) as {
      results: Array<{ source_type: string; text: string }>
    }
    expect(payload.results).toContainEqual(
      expect.objectContaining({
        source_type: 'message',
        text: '手机端 recall 验证：远程访问链路',
      })
    )
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint === '/api/team/recall')
    ).toBe(true)
  })

  it('(a5) POST /api/team/memory/add/show/search/forget round-trips over the E2E relay', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-memory-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)
    const orchestratorId = `${workspace.id}:orchestrator`
    await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
      {
        body: JSON.stringify({
          args: ['-e', 'process.stdin.resume()'],
          command: process.execPath,
        }),
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        method: 'POST',
      }
    )
    const startResponse = await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
      {
        body: JSON.stringify({ hive_port: String(h.port) }),
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        method: 'POST',
      }
    )
    expect(startResponse.status).toBe(201)
    const token = h.server.store.peekAgentToken(orchestratorId)
    if (!token) throw new Error('Expected orchestrator token after start')

    const add = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          body: 'Remote memory routes must use the E2E relay path.',
          kind: 'decision',
          tags: ['remote', 'memory'],
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/add',
    })

    expect(add.status).toBe(200)
    const addPayload = JSON.parse(td.decode(add.body)) as {
      memory: { id: string; status: string; workspace_id: string }
    }
    expect(addPayload.memory).toEqual(
      expect.objectContaining({
        status: 'active',
        workspace_id: workspace.id,
      })
    )

    const show = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          memory_id: addPayload.memory.id,
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/show',
    })

    expect(show.status).toBe(200)
    const showPayload = JSON.parse(td.decode(show.body)) as {
      memory: { id: string; sources: Array<{ actor_agent_id_snapshot: string }> }
    }
    expect(showPayload.memory).toEqual(
      expect.objectContaining({
        id: addPayload.memory.id,
        sources: expect.arrayContaining([
          expect.objectContaining({ actor_agent_id_snapshot: orchestratorId }),
        ]),
      })
    )

    const search = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          query: 'remote memory',
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/search',
    })
    expect(search.status).toBe(200)
    const searchPayload = JSON.parse(td.decode(search.body)) as {
      results: Array<{ id: string; status: string }>
    }
    expect(searchPayload.results).toEqual([
      expect.objectContaining({
        id: addPayload.memory.id,
        status: 'active',
      }),
    ])

    const forget = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          memory_id: addPayload.memory.id,
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/forget',
    })
    expect(forget.status).toBe(200)
    const forgetPayload = JSON.parse(td.decode(forget.body)) as { memory: { status: string } }
    expect(forgetPayload.memory.status).toBe('archived')

    const archivedSearch = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          query: 'remote memory',
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/search',
    })
    expect(archivedSearch.status).toBe(200)
    expect(JSON.parse(td.decode(archivedSearch.body))).toEqual({ ok: true, results: [] })

    const archivedShow = await h.gateway.openHttp({
      body: new TextEncoder().encode(
        JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token,
          memory_id: addPayload.memory.id,
        })
      ),
      headers: [['content-type', 'application/json']],
      method: 'POST',
      path: '/api/team/memory/show',
    })
    expect(archivedShow.status).toBe(200)
    const archivedShowPayload = JSON.parse(td.decode(archivedShow.body)) as {
      memory: { status: string }
    }
    expect(archivedShowPayload.memory.status).toBe('archived')

    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint === '/api/team/memory/add')
    ).toBe(true)
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint === '/api/team/memory/show')
    ).toBe(true)
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint === '/api/team/memory/search')
    ).toBe(true)
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint === '/api/team/memory/forget')
    ).toBe(true)
  })

  it('(a6) GET /api/ui/workspaces/:id/memory routes round-trip over the E2E relay', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-ui-memory-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)
    const orchestratorId = `${workspace.id}:orchestrator`
    const orchestrator = h.server.store.getAgent(workspace.id, orchestratorId)
    const memory = h.server.store.addMemoryEntry({
      actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
      body: 'UI memory routes must work over the remote relay.',
      kind: 'decision',
      tags: ['remote'],
      workspaceId: workspace.id,
    })

    const list = await h.gateway.openHttp({
      method: 'GET',
      path: `/api/ui/workspaces/${workspace.id}/memory?status=active`,
    })
    expect(list.status).toBe(200)
    const listPayload = JSON.parse(td.decode(list.body)) as {
      memories: Array<{ id: string; workspace_id: string }>
    }
    expect(listPayload.memories).toContainEqual(
      expect.objectContaining({ id: memory.id, workspace_id: workspace.id })
    )

    const settings = await h.gateway.openHttp({
      method: 'GET',
      path: `/api/ui/workspaces/${workspace.id}/memory/settings`,
    })
    expect(settings.status).toBe(200)
    expect(JSON.parse(td.decode(settings.body))).toEqual({
      dream_enabled: true,
      enabled: true,
      ok: true,
    })

    await h.audit.flush()
    expect(
      h.audit
        .list()
        .some((r) => r.action === 'http' && r.endpoint?.endsWith('/memory?status=active'))
    ).toBe(true)
    expect(
      h.audit.list().some((r) => r.action === 'http' && r.endpoint?.endsWith('/memory/settings'))
    ).toBe(true)
  })

  it('(c) a tamper frame is dropped + audited and never bridged', async () => {
    const h = await boot()
    // Seal a valid GET /api/workspaces frame on a fresh stream but flip a ciphertext byte before
    // sending it raw. The daemon must fail to open it (AEAD) → reject/open_failed, no http row.
    const sid = h.session.device.nextStreamId()
    const { encodeOpenPayload, FrameKind, StreamTransport } = await import(
      '../../src/shared/remote-protocol.js'
    )
    const frame = h.session.device.seal({
      kind: FrameKind.Open,
      streamId: sid,
      payload: encodeOpenPayload({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      }),
    })
    const tampered = new Uint8Array(frame)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    h.gateway.sendSealed(tampered)

    await waitFor(
      () => {
        h.audit.list() // force a sync flush of pending writes
        return h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
      },
      3000,
      'tamper reject row'
    )
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
    ).toBe(true)
    // Nothing was bridged to the runtime for this tampered frame.
    expect(h.audit.list().some((r) => r.action === 'http')).toBe(false)
  })

  it('(c2) an off-whitelist path is Reset + audited, never a loopback request', async () => {
    const h = await boot()
    // openHttp rejects on the daemon: the stream is Reset, so the promise rejects.
    await expect(h.gateway.openHttp({ method: 'GET', path: '/etc/passwd' })).rejects.toThrow()
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'path_not_whitelisted')
    ).toBe(true)
    expect(h.audit.list().some((r) => r.action === 'http')).toBe(false)
  })

  it('(c3) /api/ui/session is hard-denied over the tunnel — the phone never gets a hive_ui_token', async () => {
    const h = await boot()
    // Layer 1: classifyOpen denies the path → Reset, never forwarded.
    await expect(h.gateway.openHttp({ method: 'GET', path: '/api/ui/session' })).rejects.toThrow()
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'path_denied')
    ).toBe(true)
    // And no http row leaked a Set-Cookie back.
    expect(
      h.audit.list().some((r) => r.endpoint === '/api/ui/session' && r.action === 'http')
    ).toBe(false)
  })

  it('(d) revocation tears down in-flight streams and stops the tunnel', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-revoke-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)

    // Start a long-lived agent + open a terminal io stream over the tunnel.
    const script = join(wsPath, 'idle.js')
    writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
    const runId = await startAgent(h, workspace.id, script)
    const stream = await h.gateway.openWs({ path: `/ws/terminal/${runId}/io` })

    // Now revoke. The control frame must tear the tunnel down AND reset the in-flight ws stream.
    h.gateway.sendControl({ t: 'revoked', reason: 'admin revoked' })
    await waitFor(() => h.tunnel.status() === 'revoked', 4000, 'revoked')
    await waitFor(() => stream.closed(), 4000, 'in-flight stream closed')
    expect(stream.closed()).toBe(true)
    expect(h.tunnel.status()).toBe('revoked')
  })

  it('(e) peer-offline resets in-flight streams but keeps the socket — a NEW stream still gets a sealed response', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-peer-'))
    tempDirs.push(wsPath)
    await seedWorkspace(h, wsPath)

    // First request binds the device on a live socket.
    const before = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(before.status).toBe(200)

    // The phone dropped (lock-screen / network switch). The gateway emits peer-offline to the
    // daemon while keeping the DAEMON socket up (gateway/src/relay-do.ts). This must reset streams
    // WITHOUT nulling the outbound sink — otherwise every later response is silently swallowed.
    h.gateway.sendControl({ t: 'peer-offline', role: 'device' })
    // peer-offline does NOT close the session: assert no session_close was audited for it.
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'session_close' && r.rejectReason === 'peer offline')
    ).toBe(false)

    // The tunnel must still be online (the daemon socket never dropped).
    expect(h.tunnel.status()).toBe('online')

    // peer-online (informational) then a brand-new stream on the SAME socket. If the sink had been
    // nulled this would hang until timeout; it must round-trip a sealed response.
    h.gateway.sendControl({ t: 'peer-online', role: 'device' })
    const after = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(after.status).toBe(200)
    expect(JSON.parse(td.decode(after.body))).toEqual(JSON.parse(td.decode(before.body)))
  })

  it('(b) terminal WS over the tunnel relays bytes both ways through a REAL PTY', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-term-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)

    // A real echo script: prints READY, then echoes stdin both as text and hex (binary-safe check).
    const script = join(wsPath, 'echo.js')
    writeFileSync(
      script,
      [
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        'process.stdin.resume()',
        "const ready = setInterval(() => process.stdout.write('READY\\n'), 100)",
        "process.stdout.write('READY\\n')",
        "process.stdin.on('data', (chunk) => {",
        '  clearInterval(ready)',
        "  process.stdout.write('HEX:' + chunk.toString('hex') + '\\n')",
        '})',
      ].join('\n')
    )
    const runId = await startAgent(h, workspace.id, script)

    const received: string[] = []
    const stream = await h.gateway.openWs({ path: `/ws/terminal/${runId}/io` })
    stream.onMessage((data, isText) => {
      received.push(isText ? td.decode(data) : Buffer.from(data).toString())
    })

    // Daemon->phone: PTY output flows back as sealed Data.
    await waitFor(() => received.join('').includes('READY'), 8000, 'PTY output over tunnel')

    // Phone->daemon: high-bit binary stdin must survive through mux+crypto+loopback+PTY. The PTY
    // re-encodes the raw bytes the same way the direct terminal-ws test observes (0xc3 0xa9 0x21 ->
    // c383c2a921); the point is the bytes arrive non-coerced and the PTY echoes them back over the
    // tunnel — proving the WS bridge is binary-safe both directions.
    stream.send(new Uint8Array([0xc3, 0xa9, 0x21]), false)
    await waitFor(
      () => received.join('').includes('HEX:c383c2a921'),
      8000,
      'binary stdin echoed by real PTY'
    )

    // The WS-input audit row carries a byte count, not the full chunk (audit single collection point).
    await h.audit.flush()
    const wsInput = h.audit.list().find((r) => r.action === 'ws_input')
    expect(wsInput).toBeDefined()
    expect(wsInput?.byteCount).toBe(3)
    expect(wsInput?.endpoint).toBe(`/ws/terminal/${runId}/io`)
  }, 30000)

  it('(b2) a large PTY burst flows even with NO control stream (io self-acks, no deadlock)', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-burst-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)

    // Emit well over the M1 initial window (256KB) so a broken/absent ack path would stall.
    const script = join(wsPath, 'burst.js')
    writeFileSync(
      script,
      [
        "const line = 'x'.repeat(1000) + '\\n'",
        'let n = 0',
        'const t = setInterval(() => {',
        '  process.stdout.write(line)',
        '  if (++n >= 600) { clearInterval(t); process.stdout.write("DONE\\n") }',
        '}, 1)',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )
    const runId = await startAgent(h, workspace.id, script)

    let total = 0
    let done = false
    const stream = await h.gateway.openWs({ path: `/ws/terminal/${runId}/io` })
    stream.onMessage((data) => {
      total += data.length
      if (Buffer.from(data).toString().includes('DONE')) done = true
    })

    await waitFor(() => done, 20000, 'large burst drained over the tunnel without deadlock')
    expect(total).toBeGreaterThan(256 * 1024)
  }, 30000)

  it('(b3) VULN-RELIABILITY-1: a slow phone that never acks bounds the daemon->phone queue (sender window)', async () => {
    const h = await boot()
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-bridge-slow-'))
    tempDirs.push(wsPath)
    const workspace = await seedWorkspace(h, wsPath)

    // Same 600KB burst shape as (b2), but here the phone NEVER acks (this fixture seals no Ack frame
    // back to the daemon). With the bug the daemon self-acks its OWN loopback io socket so terminal
    // flow control never pauses the PTY, and it seals every chunk onto the gateway socket — the full
    // ~600KB reaches the never-reading phone (unbounded daemon memory). With the sender-window fix the
    // daemon stops draining once a full window (256KB) is unacked, so the bytes it forwards stay
    // bounded well under the whole burst.
    const script = join(wsPath, 'burst.js')
    writeFileSync(
      script,
      [
        "const line = 'x'.repeat(1000) + '\\n'",
        'let n = 0',
        'const t = setInterval(() => {',
        '  process.stdout.write(line)',
        '  if (++n >= 600) { clearInterval(t); process.stdout.write("DONE\\n") }',
        '}, 1)',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )
    const runId = await startAgent(h, workspace.id, script)

    const stream = await h.gateway.openWs({ path: `/ws/terminal/${runId}/io`, noAck: true })
    // noAck models a slow/stalled phone that never seals an Ack back; the fixture only COUNTS the
    // bytes it received (bytesReceived). The daemon's sender window must then bound the forward.

    // Let the PTY run well past one window's worth of output. The window is 256KB; the whole burst is
    // ~600KB. Give it generous wall time so a broken (unbounded) daemon would have drained the lot.
    const start = Date.now()
    while (Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 50))
      // The producer keeps running; without a sender window the bridge would keep forwarding.
    }

    // INITIAL_WINDOW is 256KB. The bridge must stop forwarding once a full window is unacked; allow
    // some slack for the in-flight loopback buffer + the 32KB ack threshold, but it must be FAR below
    // the full ~600KB burst (the bug forwards all of it).
    const forwarded = stream.bytesReceived()
    expect(forwarded).toBeGreaterThan(0)
    expect(forwarded).toBeLessThan(2 * 256 * 1024)
  }, 30000)

  // ── helpers that drive the real runtime over the cookie path (worker + agent start) ──
  async function startAgent(h: Harness, workspaceId: string, script: string): Promise<string> {
    const workerRes = await fetch(`${h.server.baseUrl}/api/workspaces/${workspaceId}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })
    const worker = (await workerRes.json()) as { id: string }
    const cfgRes = await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspaceId}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        body: JSON.stringify({ command: process.execPath, args: [script] }),
      }
    )
    expect(cfgRes.status).toBe(204)
    const startRes = await fetch(
      `${h.server.baseUrl}/api/workspaces/${workspaceId}/agents/${worker.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        body: JSON.stringify({ hive_port: String(h.port) }),
      }
    )
    expect(startRes.status).toBe(201)
    const payload = (await startRes.json()) as { run_id: string }
    return payload.run_id
  }
})
