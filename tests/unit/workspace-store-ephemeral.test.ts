import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const makeStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createWorkspaceStore(db, []) }
}

describe('workspace-store ephemeral workers', () => {
  test('persists ephemeral + spawnedBy and round-trips through a fresh hydration', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/x', 'X')
    const worker = store.addWorker(ws.id, {
      name: 'verify-1',
      role: 'reviewer',
      ephemeral: true,
      spawnedBy: 'workflow',
    })
    expect(worker.ephemeral).toBe(true)
    expect(worker.spawnedBy).toBe('workflow')

    // A fresh store over the SAME db reads from disk (hydration), not the cache.
    const store2 = createWorkspaceStore(db, [])
    const rehydrated = store2.getWorker(ws.id, worker.id)
    expect(rehydrated.ephemeral).toBe(true)
    expect(rehydrated.spawnedBy).toBe('workflow')
    db.close()
  })

  test('hydrates without crashing when the workers table predates v19 (shared data dir migrated by a newer Hive)', () => {
    // Reproduce the global ~/.config/hive data dir already migrated to a newer
    // schema by another Hive: schema_version lists 19 (so our ALTER is skipped)
    // but the workers table lacks ephemeral/spawned_by. Selecting those columns
    // must not crash; they default to non-ephemeral.
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE workers (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    for (let v = 1; v <= 19; v++) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, 0)
    }
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-legacy',
      'Legacy',
      '/tmp/legacy',
      0
    )
    db.prepare(
      'INSERT INTO workers (id, workspace_id, name, description, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('w-legacy', 'ws-legacy', 'alice', null, 'coder', 0)

    // createWorkspaceStore seeds in its constructor — this is where the crash was.
    const store = createWorkspaceStore(db, [])
    const worker = store.getWorker('ws-legacy', 'w-legacy')
    expect(worker.name).toBe('alice')
    expect(worker.ephemeral ?? false).toBe(false)
    expect(worker.spawnedBy ?? null).toBe(null)
    db.close()
  })

  test('defaults to non-ephemeral for a normal worker', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/y', 'Y')
    const worker = store.addWorker(ws.id, { name: 'alice', role: 'coder' })
    expect(worker.ephemeral ?? false).toBe(false)
    expect(worker.spawnedBy ?? null).toBe(null)

    const store2 = createWorkspaceStore(db, [])
    const rehydrated = store2.getWorker(ws.id, worker.id)
    expect(rehydrated.ephemeral ?? false).toBe(false)
    expect(rehydrated.spawnedBy ?? null).toBe(null)
    db.close()
  })
})
