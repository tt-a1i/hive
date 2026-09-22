import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
  type PersistDeviceInput,
} from '../../src/server/remote-device-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  deriveConnectionKeys,
  generateConnSalt,
  type HandshakeIds,
  REMOTE_CRYPTO_VERSION,
} from '../../src/shared/remote-crypto.js'

const dbs: Database[] = []
const tempDirs: string[] = []

const openDb = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    if (db.isOpen) db.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

// Distinct, recognisable key material so a truncated / [object Object] / wrong-key bug shows up
// byte-for-byte rather than passing by coincidence.
const sampleInput = (id = 'device-1'): PersistDeviceInput => ({
  id,
  name: 'Pixel 9',
  keys: {
    d2p: Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff),
    p2d: Uint8Array.from({ length: 32 }, (_, i) => (200 - i) & 0xff),
  },
  devicePublicKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 0xff),
})

describe('remote-device-store', () => {
  // U5(a): round-trips the directional session keys byte-for-byte.
  test('insert then getLiveSession returns the keys byte-equal to the input', () => {
    const store = createRemoteDeviceStore(openDb())
    const input = sampleInput()

    const rec = store.insert(input, 1000)
    expect(rec).toMatchObject({ id: 'device-1', name: 'Pixel 9', createdAt: 1000 })
    expect(rec.lastActive).toBeNull()
    expect(rec.revokedAt).toBeNull()

    const session = store.getLiveSession('device-1')
    expect(session).not.toBeNull()
    expect(session?.deviceId).toBe('device-1')
    // If keys were stored as "[object Object]" or truncated, these would diverge.
    expect(session?.keys.d2p).toEqual(input.keys.d2p)
    expect(session?.keys.p2d).toEqual(input.keys.p2d)
    expect(session?.keys.d2p.length).toBe(32)
    expect(session?.keys.p2d.length).toBe(32)
  })

  // U5(b): revoke drops the session from BOTH provider read paths immediately (invariant 5).
  test('revoke makes getLiveSession null and excludes the device from liveSessions', () => {
    const store = createRemoteDeviceStore(openDb())
    store.insert(sampleInput('device-1'), 1000)
    store.insert(sampleInput('device-2'), 1000)

    expect(store.getLiveSession('device-1')).not.toBeNull()
    expect(
      store
        .liveSessions()
        .map((s) => s.deviceId)
        .sort()
    ).toEqual(['device-1', 'device-2'])

    expect(store.revoke('device-1', 2000)).toBe(true)

    // The whole closed loop hinges on this: the moment the row is tombstoned the provider
    // stops handing out the key, so the next inbound frame fails 'no_session'.
    expect(store.getLiveSession('device-1')).toBeNull()
    expect(store.liveSessions().map((s) => s.deviceId)).toEqual(['device-2'])
  })

  test('revoke is idempotent and returns false for unknown / already-revoked devices', () => {
    const store = createRemoteDeviceStore(openDb())
    store.insert(sampleInput('device-1'), 1000)

    expect(store.revoke('device-1', 2000)).toBe(true)
    expect(store.revoke('device-1', 3000)).toBe(false)
    expect(store.revoke('missing', 3000)).toBe(false)

    // The original tombstone timestamp is not overwritten by a second revoke.
    expect(store.get('device-1')?.revokedAt).toBe(2000)
  })

  // U5(c): persistence across a fresh store on the same file.
  test('session material rehydrates from a reopened database on disk', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-device-store-persist-'))
    tempDirs.push(dataDir)
    const file = join(dataDir, 'runtime.sqlite')
    const input = sampleInput()

    const db1 = new Database(file)
    initializeRuntimeDatabase(db1)
    createRemoteDeviceStore(db1).insert(input, 1000)
    db1.close()

    const db2 = new Database(file)
    initializeRuntimeDatabase(db2)
    dbs.push(db2)
    const session = createRemoteDeviceStore(db2).getLiveSession('device-1')

    expect(session?.keys.d2p).toEqual(input.keys.d2p)
    expect(session?.keys.p2d).toEqual(input.keys.p2d)
  })

  // U5(d) + invariant 7: the metadata view NEVER carries key material.
  test('list / get expose metadata only — no key or pubkey fields', () => {
    const store = createRemoteDeviceStore(openDb())
    store.insert(sampleInput('device-1'), 1000)

    const fromList = store.list()[0]
    const fromGet = store.get('device-1')
    expect(fromList).toBeDefined()
    expect(fromGet).toBeDefined()

    for (const rec of [fromList, fromGet]) {
      if (!rec) throw new Error('Expected stored device metadata')
      expect(Object.keys(rec).sort()).toEqual([
        'createdAt',
        'id',
        'lastActive',
        'name',
        'revokedAt',
      ])
      expect('keys' in rec).toBe(false)
      expect('key_d2p' in rec).toBe(false)
      expect('key_p2d' in rec).toBe(false)
      expect('devicePublicKey' in rec).toBe(false)
      expect('device_pubkey' in rec).toBe(false)
    }
    // Belt-and-suspenders: the serialised record must not contain the base64url of either key.
    const serialized = JSON.stringify(store.list())
    expect(serialized).not.toContain('AQID') // base64url prefix of the d2p sample (1,2,3,…)
  })

  test('list is newest-first and hides revoked devices unless asked', () => {
    const store = createRemoteDeviceStore(openDb())
    store.insert(sampleInput('device-1'), 1000)
    store.insert(sampleInput('device-2'), 2000)
    store.insert(sampleInput('device-3'), 3000)
    store.revoke('device-2', 4000)

    expect(store.list().map((r) => r.id)).toEqual(['device-3', 'device-1'])
    expect(store.list(true).map((r) => r.id)).toEqual(['device-3', 'device-2', 'device-1'])
  })

  test('touchActive bumps last_active without resurrecting a revoked row', () => {
    const store = createRemoteDeviceStore(openDb())
    store.insert(sampleInput('device-1'), 1000)

    store.touchActive('device-1', 1500)
    expect(store.get('device-1')?.lastActive).toBe(1500)

    store.revoke('device-1', 2000)
    store.touchActive('device-1', 2500)
    // A frame for a revoked device must not flip it back to active.
    expect(store.getLiveSession('device-1')).toBeNull()
    expect(store.get('device-1')?.revokedAt).toBe(2000)
  })

  test('getLiveSession returns null for an unknown device', () => {
    const store = createRemoteDeviceStore(openDb())
    expect(store.getLiveSession('nope')).toBeNull()
    expect(store.get('nope')).toBeNull()
  })

  // C1 (M6.1) — the at-rest shape is UNCHANGED. The columns hold ROOT material now, but the schema is
  // still exactly v24: no new column, no version bump. A migration that bumped the SQLite shape (a new
  // root_* column) would strand v24 rows; this introspection trips on it.
  test('the remote_devices column set is exactly v24 (no schema change for root reinterpretation)', () => {
    const db = openDb()
    createRemoteDeviceStore(db) // prepares statements against the live schema
    const cols = (db.prepare('PRAGMA table_info(remote_devices)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort()
    expect(cols).toEqual(
      [
        'created_at',
        'device_pubkey',
        'id',
        'key_d2p',
        'key_p2d',
        'last_active',
        'name',
        'revoked_at',
      ].sort()
    )
  })

  // C1b (M6.1, CENTERPIECE for this slice) — the persisted bytes are the ROOT and DRIVE
  // deriveConnectionKeys. A connKey derived from the rehydrated stored root + a salt pair byte-equals
  // one derived from the original live root + the SAME salts. This is the daemon-side reload consumer:
  // the bridge feeds session.keys (these bytes) straight into deriveConnectionKeys.
  test('the stored root drives deriveConnectionKeys identically to the live root', () => {
    const store = createRemoteDeviceStore(openDb())
    const input = sampleInput()
    store.insert(input, 1000)

    const session = store.getLiveSession('device-1')
    expect(session).not.toBeNull()
    if (!session) throw new Error('no session')

    const ids: HandshakeIds = {
      daemonId: 'daemon-1',
      deviceId: 'device-1',
      protocolVersion: REMOTE_CRYPTO_VERSION,
    }
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()

    const fromStored = deriveConnectionKeys({
      rootD2p: session.keys.d2p,
      rootP2d: session.keys.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids,
    })
    const fromLive = deriveConnectionKeys({
      rootD2p: input.keys.d2p,
      rootP2d: input.keys.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids,
    })

    expect(fromStored.d2p).toEqual(fromLive.d2p)
    expect(fromStored.p2d).toEqual(fromLive.p2d)
    // the connKey is NOT the root — rekey actually fires (guards a future no-op derive).
    expect(fromStored.d2p).not.toEqual(session.keys.d2p)
    expect(fromStored.p2d).not.toEqual(session.keys.p2d)
  })
})

describe('createPersistentDeviceSessionProvider', () => {
  test('get returns the live session and null once the device is revoked', () => {
    const store = createRemoteDeviceStore(openDb())
    const provider = createPersistentDeviceSessionProvider(store)
    const input = sampleInput()
    store.insert(input, 1000)

    const session = provider.get('device-1')
    expect(session?.keys.p2d).toEqual(input.keys.p2d)
    expect(provider.candidates().map((s) => s.deviceId)).toEqual(['device-1'])

    store.revoke('device-1', 2000)

    // Closed loop, persistent half: the provider reads the store live, so revoke takes effect
    // on the very next lookup with no cache to invalidate.
    expect(provider.get('device-1')).toBeNull()
    expect(provider.candidates()).toEqual([])
  })

  test('provider has no trust logic of its own — it only mirrors the store', () => {
    const store = createRemoteDeviceStore(openDb())
    const provider = createPersistentDeviceSessionProvider(store)

    // Nothing inserted (no desktop confirm) => no usable session. This is the persistent half of
    // invariant 1/4: a device that was never confirmed simply has no row, so get() is null.
    expect(provider.get('device-1')).toBeNull()
    expect(provider.candidates()).toEqual([])
  })
})
