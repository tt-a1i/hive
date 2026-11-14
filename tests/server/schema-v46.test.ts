import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { applySchemaVersion26 } from '../../src/server/sqlite-schema-v26.js'
import { applySchemaVersion27 } from '../../src/server/sqlite-schema-v27.js'
import { applySchemaVersion28 } from '../../src/server/sqlite-schema-v28.js'
import { applySchemaVersion37 } from '../../src/server/sqlite-schema-v37.js'
import { applySchemaVersion41 } from '../../src/server/sqlite-schema-v41.js'
import { createTeamRecallStore } from '../../src/server/team-recall-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

test('v45 data upgrades without losing dispatch history and stays clean on reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-v46-'))
  const path = join(dir, 'runtime.sqlite')
  try {
    let db = new Database(path)
    initializeRuntimeDatabase(db)
    // Recreate the v45 objects using the actual historical migrations.
    db.exec('DELETE FROM schema_version WHERE version = 46')
    applySchemaVersion26(db)
    applySchemaVersion27(db)
    applySchemaVersion28(db)
    applySchemaVersion37(db)
    applySchemaVersion41(db)
    db.exec(`
      CREATE TABLE controller_notifications (id TEXT PRIMARY KEY);
      CREATE TABLE controller_connect_requests (id TEXT PRIMARY KEY);
      INSERT INTO workspaces (id, name, path, created_at, controller_mode)
        VALUES ('legacy', 'Legacy', '/tmp/hive-legacy', 1, 'codex_app');
      INSERT INTO workers (id, workspace_id, name, role, created_at)
        VALUES ('worker', 'legacy', 'Orchestrator', 'coder', 1);
      INSERT INTO memory_entries (id, workspace_id, kind, body, status, created_at, updated_at)
        VALUES ('memory', 'legacy', 'fact', 'retired memory', 'active', 1, 1);
      INSERT INTO dispatches (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at)
        VALUES ('old', 'legacy', 'legacy:orchestrator', 'worker', 'historic migration marker', 'queued', 1);
      INSERT INTO agent_runs (run_id, agent_id, status, started_at, created_at, updated_at)
        VALUES ('run', 'worker', 'running', 1, 1, 1);
    `)
    db.close()
    db = new Database(path)
    initializeRuntimeDatabase(db)
    const retired = [
      'controller_notifications',
      'controller_operations',
      'controller_connect_requests',
      'workspace_controllers',
      'external_goal_events',
      'external_goal_sessions',
      'dream_runs',
      'memory_injections',
      'memory_sources',
      'memory_fts',
      'memory_fts_trigram',
      'memory_entries',
      'controller_dispatch_terminal',
      'controller_member_exit',
      'memory_fts_ai',
      'memory_fts_ad',
      'memory_fts_au',
    ]
    for (const name of retired) {
      expect(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name)).toBeUndefined()
    }
    expect(db.prepare('SELECT controller_mode FROM workspaces WHERE id = ?').get('legacy')).toEqual(
      { controller_mode: 'internal' }
    )
    expect(
      db.prepare('SELECT id, role FROM workers WHERE workspace_id = ? ORDER BY id').all('legacy')
    ).toEqual([
      { id: 'legacy:orchestrator', role: 'orchestrator' },
      { id: 'worker', role: 'coder' },
    ])
    const workspace = createWorkspaceStore(db, []).getWorkspaceSnapshot('legacy')
    expect(workspace.agents.filter((agent) => agent.role === 'orchestrator')).toHaveLength(1)
    expect(workspace.agents.find((agent) => agent.id === 'worker')?.name).toBe('Orchestrator')
    db.exec(`
      UPDATE dispatches SET status = 'reported', report_text = 'completed' WHERE id = 'old';
      UPDATE agent_runs SET status = 'exited' WHERE run_id = 'run';
      INSERT INTO dispatches (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at)
        VALUES ('new', 'legacy', 'legacy:orchestrator', 'worker', 'new ledger marker', 'queued', 2);
    `)
    expect(
      createTeamRecallStore(db)
        .recallMessages('legacy', 'historic migration marker')
        .map((item) => item.dispatchId)
    ).toContain('old')
    expect(db.prepare('SELECT status FROM dispatches WHERE id = ?').get('new')).toEqual({
      status: 'queued',
    })
    db.close()
    db = new Database(path)
    initializeRuntimeDatabase(db)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 46').get()).toEqual({
      version: 46,
    })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM workers WHERE id = ?').get('legacy:orchestrator')
    ).toEqual({ count: 1 })
    for (const name of retired)
      expect(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name)).toBeUndefined()
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v46 accepts a v45 version stamp without the legacy mode column', () => {
  const db = new Database(':memory:')
  try {
    initializeRuntimeDatabase(db)
    db.exec(`
      DELETE FROM schema_version WHERE version = 46;
      INSERT INTO workspaces (id, name, path, created_at) VALUES ('foreign', 'Foreign', '/tmp/foreign', 1);
    `)
    initializeRuntimeDatabase(db)
    expect(
      db.prepare('SELECT id, role FROM workers WHERE workspace_id = ?').all('foreign')
    ).toEqual([{ id: 'foreign:orchestrator', role: 'orchestrator' }])
    const store = createWorkspaceStore(db, [])
    const created = store.createWorkspace('/tmp/new-hive-v46', 'New')
    expect(
      db.prepare('SELECT id, role FROM workers WHERE workspace_id = ?').all(created.id)
    ).toEqual([{ id: `${created.id}:orchestrator`, role: 'orchestrator' }])
    expect(
      store.getWorkspaceSnapshot(created.id).agents.filter((agent) => agent.role === 'orchestrator')
    ).toHaveLength(1)
  } finally {
    db.close()
  }
})
