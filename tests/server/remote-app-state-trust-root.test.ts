import { afterEach, describe, expect, test } from 'vitest'

import {
  listRemoteConfigKeys,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../../src/server/remote-config-keys.js'
import {
  HIVE_REMOTE_DEVICE_HEADER,
  HIVE_REMOTE_SECRET_HEADER,
} from '../../src/server/remote-loopback-auth.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Trust-root: tunnel-origin requests must not read or write remote-config app-state
// keys, and remote_enabled must not be armed via the generic KV route from any
// origin. Official PUT /api/remote/enabled remains the only Remote-ON writer.
//
// Real HTTP + real store (SQLite). Tunnel origin is the per-boot secret header
// the loopback bridge stamps — the same signal authorizeRemoteTunnelRequest uses.

type Server = Awaited<ReturnType<typeof startTestServer>>
const servers: Server[] = []

afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

const TOKEN = 'hd_secret_daemon_token'
const GATEWAY = 'https://app.hivehq.dev'
const DAEMON_ID = 'daemon-trust-root'

const seedRemote = (store: Server['store']) => {
  store.settings.setAppState(REMOTE_DAEMON_TOKEN_KEY, TOKEN)
  store.settings.setAppState(REMOTE_GATEWAY_URL_KEY, GATEWAY)
  store.settings.setAppState(REMOTE_DAEMON_ID_KEY, DAEMON_ID)
  store.settings.setAppState(REMOTE_ENABLED_KEY, 'false')
}

const tunnelHeaders = (store: Server['store']) => ({
  [HIVE_REMOTE_SECRET_HEADER]: store.getRemoteTunnelSecret(),
  [HIVE_REMOTE_DEVICE_HEADER]: 'phone-trust-root',
  'content-type': 'application/json',
})

describe('remote app-state trust root', () => {
  test('tunnel GET/PUT of every remote-config key is 403 and does not leak or persist', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    seedRemote(srv.store)
    const headers = tunnelHeaders(srv.store)
    const keys = listRemoteConfigKeys()
    expect(keys).toEqual(
      expect.arrayContaining([
        REMOTE_DAEMON_TOKEN_KEY,
        REMOTE_ENABLED_KEY,
        REMOTE_GATEWAY_URL_KEY,
        REMOTE_DAEMON_ID_KEY,
      ])
    )

    for (const key of keys) {
      const before = srv.store.settings.getAppState(key)?.value ?? null
      const getRes = await fetch(`${srv.baseUrl}/api/settings/app-state/${key}`, { headers })
      const getText = await getRes.text()
      expect(getRes.status).toBe(403)
      expect(getText).not.toContain(TOKEN)
      if (before) expect(getText).not.toContain(before)

      const putRes = await fetch(`${srv.baseUrl}/api/settings/app-state/${key}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: key === REMOTE_ENABLED_KEY ? 'true' : 'attacker' }),
      })
      expect(putRes.status).toBe(403)
      expect(srv.store.settings.getAppState(key)?.value ?? null).toBe(before)
    }
  })

  test('official remote-ON from the tunnel is still 403; local desktop app-state still works', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    seedRemote(srv.store)
    const cookie = await getUiCookie(srv.baseUrl)
    const tunnel = tunnelHeaders(srv.store)

    const officialOn = await fetch(`${srv.baseUrl}/api/remote/enabled`, {
      method: 'PUT',
      headers: tunnel,
      body: JSON.stringify({ enabled: true }),
    })
    expect(officialOn.status).toBe(403)
    expect(srv.store.settings.getAppState(REMOTE_ENABLED_KEY)?.value).toBe('false')

    const localGet = await fetch(
      `${srv.baseUrl}/api/settings/app-state/${REMOTE_DAEMON_TOKEN_KEY}`,
      { headers: { cookie } }
    )
    expect(localGet.status).toBe(403)

    const localPutEnabled = await fetch(
      `${srv.baseUrl}/api/settings/app-state/${REMOTE_ENABLED_KEY}`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'true' }),
      }
    )
    expect(localPutEnabled.status).toBe(403)
    expect(srv.store.settings.getAppState(REMOTE_ENABLED_KEY)?.value).toBe('false')

    const officialLocalOn = await fetch(`${srv.baseUrl}/api/remote/enabled`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(officialLocalOn.status).toBe(200)
    expect(srv.store.settings.getAppState(REMOTE_ENABLED_KEY)?.value).toBe('true')

    const wsPut = await fetch(`${srv.baseUrl}/api/settings/app-state/active_workspace_id`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'ws-1' }),
    })
    expect(wsPut.status).toBe(204)
    expect(srv.store.settings.getAppState('active_workspace_id')?.value).toBe('ws-1')

    const wsGetTunnel = await fetch(`${srv.baseUrl}/api/settings/app-state/active_workspace_id`, {
      headers: tunnel,
    })
    expect(wsGetTunnel.status).toBe(200)
    expect(((await wsGetTunnel.json()) as { value: string | null }).value).toBe('ws-1')
  })
})
