import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'

const tempDirs: string[] = []
const makeWorkspacePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-m1a-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('addWorkerWithLaunch', () => {
  test('creates the worker and its launch config together', () => {
    const store = createRuntimeStore()
    const ws = store.createWorkspace(makeWorkspacePath(), 'A')
    const worker = store.addWorkerWithLaunch(
      ws.id,
      { name: 'verify-1', role: 'reviewer', ephemeral: true, spawnedBy: 'workflow' },
      { command: 'claude', args: [] }
    )
    expect(store.peekAgentLaunchConfig(ws.id, worker.id)).toMatchObject({ command: 'claude' })
    expect(store.getWorker(ws.id, worker.id).ephemeral).toBe(true)
    expect(store.getWorker(ws.id, worker.id).spawnedBy).toBe('workflow')
  })

  test('rolls back the worker when the launch config write fails', async () => {
    const dataDir = makeWorkspacePath()
    const store = createRuntimeStore({ dataDir })
    const ws = store.createWorkspace(makeWorkspacePath(), 'B')
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(
      `CREATE TRIGGER fail_config BEFORE INSERT ON agent_launch_configs BEGIN SELECT RAISE(ABORT, 'blocked config'); END`
    )
    try {
      expect(() =>
        store.addWorkerWithLaunch(
          ws.id,
          { name: 'verify-2', role: 'reviewer' },
          { command: 'claude' }
        )
      ).toThrow()
      expect(store.listWorkers(ws.id)).toEqual([])
      expect(
        db
          .prepare('SELECT id FROM workers WHERE workspace_id = ? AND role != ?')
          .all(ws.id, 'orchestrator')
      ).toEqual([])
    } finally {
      db.close()
      await store.close()
    }
  })

  test('failed SQLite commit leaves neither worker nor launch config in memory or DB', async () => {
    const dataDir = makeWorkspacePath()
    const store = createRuntimeStore({ dataDir })
    const ws = store.createWorkspace(makeWorkspacePath(), 'Commit failure')
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE commit_child (id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_worker_commit AFTER INSERT ON agent_launch_configs BEGIN
        INSERT INTO commit_child (id) VALUES (7);
      END;
      CREATE TRIGGER prevent_compensation BEFORE DELETE ON workers BEGIN
        SELECT RAISE(ABORT, 'blocked compensation');
      END;
    `)
    try {
      expect(() =>
        store.addWorkerWithLaunch(ws.id, { name: 'failed', role: 'coder' }, { command: 'node' })
      ).toThrow()
      expect(store.listWorkers(ws.id)).toEqual([])
      expect(
        db
          .prepare('SELECT id FROM workers WHERE workspace_id = ? AND role != ?')
          .all(ws.id, 'orchestrator')
      ).toEqual([])
      expect(
        db.prepare('SELECT agent_id FROM agent_launch_configs WHERE workspace_id = ?').all(ws.id)
      ).toEqual([])
      expect(db.prepare('SELECT id FROM commit_child').all()).toEqual([])
    } finally {
      db.close()
      await store.close()
    }
  })
  test('failed workspace delete commit preserves launch config in SQLite and cache', async () => {
    const dataDir = makeWorkspacePath()
    const store = createRuntimeStore({ dataDir })
    const ws = store.createWorkspace(makeWorkspacePath(), 'delete rollback')
    const worker = store.addWorkerWithLaunch(
      ws.id,
      { name: 'kept', role: 'coder' },
      { command: 'node', args: ['-v'] }
    )
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE delete_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE delete_child (id INTEGER REFERENCES delete_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_delete_commit AFTER DELETE ON workspaces BEGIN INSERT INTO delete_child (id) VALUES (8); END;
    `)
    try {
      await expect(store.deleteWorkspace(ws.id)).rejects.toThrow()
      expect(store.getWorker(ws.id, worker.id).name).toBe('kept')
      expect(store.peekAgentLaunchConfig(ws.id, worker.id)).toMatchObject({
        command: 'node',
        args: ['-v'],
      })
      expect(
        db
          .prepare(
            'SELECT command, args_json FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
          )
          .get(ws.id, worker.id)
      ).toEqual({ command: 'node', args_json: '["-v"]' })
      db.exec('DROP TRIGGER fail_delete_commit')
      await store.deleteWorkspace(ws.id)
      expect(store.peekAgentLaunchConfig(ws.id, worker.id)).toBeUndefined()
      expect(
        db.prepare('SELECT agent_id FROM agent_launch_configs WHERE workspace_id = ?').all(ws.id)
      ).toEqual([])
    } finally {
      db.close()
      await store.close()
    }
  })
})
