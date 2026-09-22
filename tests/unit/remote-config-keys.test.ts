import { afterEach, describe, expect, test } from 'vitest'
import { createAppStateStore } from '../../src/server/app-state-store.js'
import {
  createRemoteConfigSource,
  DEFAULT_GATEWAY_URL,
  isRemoteConfigKey,
  listRemoteConfigKeys,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../../src/server/remote-config-keys.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const dbs: Database[] = []

const openStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  dbs.push(db)
  return createAppStateStore(db)
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('remote app_state key constants', () => {
  // These exact snake_case strings are the on-disk contract: the CLI writes
  // them and the daemon-side tunnel reads them. If anyone renames one on only
  // one side, login would silently never reach the tunnel. Pin the literals so
  // a rename has to touch this test.
  test('the four keys + default gateway are the landed snake_case literals', () => {
    expect(REMOTE_GATEWAY_URL_KEY).toBe('remote_gateway_url')
    expect(REMOTE_DAEMON_TOKEN_KEY).toBe('remote_daemon_token')
    expect(REMOTE_DAEMON_ID_KEY).toBe('remote_daemon_id')
    expect(REMOTE_ENABLED_KEY).toBe('remote_enabled')
    expect(DEFAULT_GATEWAY_URL).toBe('https://app.hivehq.dev')
    expect(listRemoteConfigKeys()).toEqual(
      expect.arrayContaining([
        REMOTE_GATEWAY_URL_KEY,
        REMOTE_DAEMON_TOKEN_KEY,
        REMOTE_DAEMON_ID_KEY,
        REMOTE_ENABLED_KEY,
      ])
    )
    expect(isRemoteConfigKey(REMOTE_DAEMON_TOKEN_KEY)).toBe(true)
    expect(isRemoteConfigKey('active_workspace_id')).toBe(false)
  })

  test('the CLI re-exports the SAME constant objects (single source of truth)', async () => {
    const cli = await import('../../src/cli/hive-remote.js')
    expect(cli.REMOTE_GATEWAY_URL_KEY).toBe(REMOTE_GATEWAY_URL_KEY)
    expect(cli.REMOTE_DAEMON_TOKEN_KEY).toBe(REMOTE_DAEMON_TOKEN_KEY)
    expect(cli.REMOTE_DAEMON_ID_KEY).toBe(REMOTE_DAEMON_ID_KEY)
    expect(cli.REMOTE_ENABLED_KEY).toBe(REMOTE_ENABLED_KEY)
    expect(cli.DEFAULT_GATEWAY_URL).toBe(DEFAULT_GATEWAY_URL)
  })
})

describe('createRemoteConfigSource', () => {
  test('a fresh config is OFF and logged out — no socket, no token', () => {
    const config = createRemoteConfigSource(openStore())
    expect(config.isEnabled()).toBe(false)
    expect(config.getGatewayUrl()).toBeNull()
    expect(config.getDaemonToken()).toBeNull()
    expect(config.getDaemonId()).toBeNull()
  })

  test('isEnabled is true ONLY for the exact string "true"', () => {
    const store = openStore()
    const config = createRemoteConfigSource(store)

    // Invariant 4: off = zero behavior change. Anything that is not exactly
    // 'true' must read as OFF, so a stray value can never silently arm the
    // tunnel. If isEnabled used a truthy check, '1'/'yes'/'TRUE' would flip it.
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', 'false', '', 'enabled']) {
      store.set(REMOTE_ENABLED_KEY, value)
      expect(config.isEnabled()).toBe(false)
    }

    store.set(REMOTE_ENABLED_KEY, 'true')
    expect(config.isEnabled()).toBe(true)
  })

  test('reads gateway url, daemon token and daemon id straight from app_state', () => {
    const store = openStore()
    store.set(REMOTE_GATEWAY_URL_KEY, 'https://gw.test')
    store.set(REMOTE_DAEMON_TOKEN_KEY, 'hd_secret')
    store.set(REMOTE_DAEMON_ID_KEY, 'daemon-9')

    const config = createRemoteConfigSource(store)
    expect(config.getGatewayUrl()).toBe('https://gw.test')
    expect(config.getDaemonToken()).toBe('hd_secret')
    expect(config.getDaemonId()).toBe('daemon-9')
  })

  test('reflects live writes — logout clears the token so the source reads logged-out', () => {
    const store = openStore()
    store.set(REMOTE_ENABLED_KEY, 'true')
    store.set(REMOTE_DAEMON_TOKEN_KEY, 'hd_secret')

    const config = createRemoteConfigSource(store)
    expect(config.isEnabled()).toBe(true)
    expect(config.getDaemonToken()).toBe('hd_secret')

    // Mirror `hive remote logout`: token cleared to null, enabled flipped off.
    store.set(REMOTE_DAEMON_TOKEN_KEY, null)
    store.set(REMOTE_ENABLED_KEY, 'false')

    expect(config.isEnabled()).toBe(false)
    expect(config.getDaemonToken()).toBeNull()
  })

  test('a login written through the CLI store is read back by the daemon source', async () => {
    const { REMOTE_GATEWAY_URL_KEY: cliGateway, runHiveRemoteCommand } = await import(
      '../../src/cli/hive-remote.js'
    )
    const store = openStore()

    // Drive the real CLI login against the SAME app_state store, then prove the
    // daemon-side source reads exactly what the CLI persisted. This is the
    // CLI-writes / daemon-reads contract that wires login → tunnel.
    const exit = await runHiveRemoteCommand(['login', '--gateway', 'https://gw.test'], {
      config: store,
      client: {
        async requestCode() {
          return { code: 'c', expiresAt: 10_000, pollIntervalMs: 1 }
        },
        async exchangeToken() {
          return { daemonId: 'daemon-x', daemonToken: 'hd_live' }
        },
      },
      log: () => {},
      error: () => {},
      sleep: async () => {},
    })

    expect(exit).toBe(0)
    expect(store.get(cliGateway)?.value).toBe('https://gw.test')

    const config = createRemoteConfigSource(store)
    expect(config.isEnabled()).toBe(true)
    expect(config.getGatewayUrl()).toBe('https://gw.test')
    expect(config.getDaemonToken()).toBe('hd_live')
    expect(config.getDaemonId()).toBe('daemon-x')
  })
})
