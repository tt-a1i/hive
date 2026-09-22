import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database, { type Database as SqliteDatabase } from '../../src/server/sqlite.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'
import { applySchemaVersion25 } from '../../src/server/sqlite-schema-v25.js'
import { applySchemaVersion26 } from '../../src/server/sqlite-schema-v26.js'
import { applySchemaVersion27 } from '../../src/server/sqlite-schema-v27.js'
import { applySchemaVersion36 } from '../../src/server/sqlite-schema-v36.js'
import { applySchemaVersion44 } from '../../src/server/sqlite-schema-v44.js'
import { applySchemaVersion45 } from '../../src/server/sqlite-schema-v45.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

const expectDispatchSchema = (db: SqliteDatabase) => {
  const dispatchTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatches'")
    .get() as { name: string } | undefined
  const dispatchIndexes = new Set(
    (db.prepare('PRAGMA index_list(dispatches)').all() as Array<{ name: string }>).map(
      (index) => index.name
    )
  )

  expect(dispatchTable).toEqual({ name: 'dispatches' })
  expect(dispatchIndexes.has('idx_dispatches_workspace_created_at')).toBe(true)
  expect(dispatchIndexes.has('idx_dispatches_open_by_worker')).toBe(true)
}

const indexColumns = (db: SqliteDatabase, indexName: string) =>
  (db.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  )

const tableColumns = (db: SqliteDatabase, tableName: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

const tableIndexes = (db: SqliteDatabase, tableName: string) =>
  new Set(
    (db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>).map(
      (index) => index.name
    )
  )

const ftsHitCount = (db: SqliteDatabase, table: string, query: string) =>
  (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get(query) as {
      count: number
    }
  ).count

describe('schema version', () => {
  test('runtime sqlite initializes a schema_version table', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-version-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get() as { name: string } | undefined

    expect(row).toEqual({ name: 'schema_version' })
    db.close()
  })

  test('latest schema includes last_session_id, pid, ended_at and drops messages.kind', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-columns-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
    const workerColumns = new Set(
      (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const agentRunColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const launchConfigColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const commandPresetColumns = new Set(
      (db.prepare('PRAGMA table_info(command_presets)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const roleTemplateColumns = new Set(
      (db.prepare('PRAGMA table_info(role_templates)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const appStateColumns = new Set(
      (db.prepare('PRAGMA table_info(app_state)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const messageColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const dispatchColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const dreamRunColumns = new Set(
      (db.prepare('PRAGMA table_info(dream_runs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const externalGoalSessionColumns = tableColumns(db, 'external_goal_sessions')
    const externalGoalEventColumns = tableColumns(db, 'external_goal_events')
    const externalGoalSessionIndexes = tableIndexes(db, 'external_goal_sessions')
    const externalGoalEventIndexes = tableIndexes(db, 'external_goal_events')

    expect(workerColumns.has('last_session_id')).toBe(true)
    expect(workerColumns.has('avatar')).toBe(true)
    expect(agentRunColumns.has('pid')).toBe(true)
    expect(agentRunColumns.has('ended_at')).toBe(true)
    expect(launchConfigColumns.has('command_preset_id')).toBe(true)
    expect(launchConfigColumns.has('interactive_command')).toBe(true)
    expect(launchConfigColumns.has('preset_augmentation_disabled')).toBe(true)
    expect(launchConfigColumns.has('resume_args_template')).toBe(true)
    expect(launchConfigColumns.has('session_id_capture_json')).toBe(true)
    expect(launchConfigColumns.has('cwd')).toBe(true)
    expect(commandPresetColumns).toEqual(
      new Set([
        'id',
        'display_name',
        'command',
        'args',
        'env',
        'resume_args_template',
        'session_id_capture',
        'yolo_args_template',
        'is_builtin',
        'created_at',
        'updated_at',
      ])
    )
    expect(roleTemplateColumns).toEqual(
      new Set([
        'id',
        'name',
        'role_type',
        'description',
        'default_command',
        'default_args',
        'default_env',
        'is_builtin',
        'created_at',
        'updated_at',
      ])
    )
    expect(appStateColumns).toEqual(new Set(['key', 'value', 'updated_at']))
    expect(messageColumns.has('kind')).toBe(false)
    expect(dispatchColumns).toEqual(
      new Set([
        'sequence',
        'id',
        'workspace_id',
        'from_agent_id',
        'to_agent_id',
        'text',
        'status',
        'created_at',
        'delivered_at',
        'submitted_at',
        'reported_at',
        'report_text',
        'parent_dispatch_id',
        'root_dispatch_id',
        'seen_seq',
        'outcome',
        'delegated_from_id',
        'artifacts',
        'workflow_run_id',
        'step_index',
        // M2-A added these two for per-phase / per-agent grouping in the
        // workflow-run-detail UI; idempotent ALTER lives in sqlite-schema base init.
        'phase',
        'label',
        'dispatch_payload_bytes',
        'report_payload_bytes',
      ])
    )
    expect(dreamRunColumns).toEqual(
      new Set([
        'id',
        'workspace_id',
        'trigger',
        'status',
        'started_at',
        'finished_at',
        'input_seq_from',
        'input_seq_to',
        'report',
        'revert_blob',
        'error',
      ])
    )
    expect(externalGoalSessionColumns).toEqual(
      new Set([
        'id',
        'workspace_id',
        'source',
        'goal',
        'context_json',
        'status',
        'title',
        'summary',
        'created_at',
        'updated_at',
        'closed_at',
      ])
    )
    expect(externalGoalEventColumns).toEqual(
      new Set([
        'sequence',
        'id',
        'goal_id',
        'workspace_id',
        'kind',
        'status',
        'body',
        'artifacts_json',
        'created_at',
      ])
    )
    expect(externalGoalSessionIndexes.has('idx_external_goal_sessions_workspace')).toBe(true)
    expect(indexColumns(db, 'idx_external_goal_sessions_workspace')).toEqual([
      'workspace_id',
      'created_at',
    ])
    expect(externalGoalEventIndexes.has('idx_external_goal_events_goal')).toBe(true)
    expect(indexColumns(db, 'idx_external_goal_events_goal')).toEqual(['goal_id', 'sequence'])
    expect(externalGoalEventIndexes.has('idx_external_goal_events_workspace')).toBe(true)
    expect(indexColumns(db, 'idx_external_goal_events_workspace')).toEqual([
      'workspace_id',
      'created_at',
    ])
    expectDispatchSchema(db)

    const presetCount = db
      .prepare('SELECT COUNT(*) AS count FROM command_presets WHERE is_builtin = 1')
      .get() as { count: number }
    const piPreset = db
      .prepare(
        'SELECT id, display_name, command, resume_args_template, session_id_capture, yolo_args_template, is_builtin FROM command_presets WHERE id = ?'
      )
      .get('pi') as {
      id: string
      display_name: string
      command: string
      resume_args_template: string | null
      session_id_capture: string | null
      yolo_args_template: string | null
      is_builtin: number
    }
    const roleTemplateCount = db
      .prepare('SELECT COUNT(*) AS count FROM role_templates WHERE is_builtin = 1')
      .get() as { count: number }
    const appState = db
      .prepare('SELECT key, value FROM app_state WHERE key = ?')
      .get('active_workspace_id') as { key: string; value: string | null } | undefined
    const schemaVersion = db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(CURRENT_SCHEMA_VERSION) as { version: number } | undefined

    expect(presetCount.count).toBe(10)
    expect(piPreset).toEqual({
      command: 'pi',
      display_name: 'Pi',
      id: 'pi',
      is_builtin: 1,
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: '["--approve"]',
    })
    expect(roleTemplateCount.count).toBe(4)
    expect(appState).toEqual({ key: 'active_workspace_id', value: null })
    expect(schemaVersion).toEqual({ version: CURRENT_SCHEMA_VERSION })

    db.close()
  })

  test('v25 backfills and maintains messages/dispatches FTS, including CJK trigram search', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        workflow_run_id TEXT,
        step_index INTEGER,
        phase TEXT,
        label TEXT
      );
    `)
    db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, from_agent_id, to_agent_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('ws-1', 'worker-1', 'report', 'worker-1', null, '修复远程访问链路断线', 1)
    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-1',
      'ws-1',
      'orch-1',
      'worker-1',
      '检查移动端',
      'reported',
      1,
      '远程访问链路已恢复'
    )

    applySchemaVersion25(db)

    expect(ftsHitCount(db, 'messages_fts_trigram', '"访问链"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"访问链"')).toBe(1)

    const inserted = db
      .prepare(
        `INSERT INTO messages (
          workspace_id, worker_id, type, text, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run('ws-1', 'worker-1', 'status', 'fresh recall marker', 2)
    expect(ftsHitCount(db, 'messages_fts', '"fresh" AND "marker"')).toBe(1)

    db.prepare('DELETE FROM messages WHERE sequence = ?').run(Number(inserted.lastInsertRowid))
    expect(ftsHitCount(db, 'messages_fts', '"fresh" AND "marker"')).toBe(0)

    db.prepare('UPDATE dispatches SET report_text = ? WHERE id = ?').run(
      '改为新的 dispatch recall marker',
      'dispatch-1'
    )
    expect(ftsHitCount(db, 'dispatches_fts', '"dispatch" AND "recall"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"访问链"')).toBe(0)

    db.close()
  })

  test('v25 rebuilds pre-existing empty FTS tables from a half-applied migration', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        workflow_run_id TEXT,
        step_index INTEGER,
        phase TEXT,
        label TEXT
      );
      CREATE VIRTUAL TABLE messages_fts
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE messages_fts_trigram
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');
      CREATE VIRTUAL TABLE dispatches_fts
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE dispatches_fts_trigram
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');
    `)
    db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, text, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('ws-1', 'worker-1', 'report', 'half migration recall marker', 1)

    applySchemaVersion25(db)

    expect(ftsHitCount(db, 'messages_fts', '"half" AND "marker"')).toBe(1)
    db.close()
  })

  test('runtime init repairs unhealthy v25 FTS when schema_version already contains 25', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        workflow_run_id TEXT,
        step_index INTEGER,
        phase TEXT,
        label TEXT
      );
      CREATE VIRTUAL TABLE messages_fts
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE messages_fts_trigram
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');
      CREATE VIRTUAL TABLE dispatches_fts
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE dispatches_fts_trigram
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');
    `)
    for (let version = 1; version <= 25; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }
    db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, text, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('ws-1', 'worker-1', 'report', 'already stamped recall marker', 1)

    initializeRuntimeDatabase(db)

    expect(ftsHitCount(db, 'messages_fts', '"stamped" AND "marker"')).toBe(1)
    db.close()
  })

  test('runtime init keeps healthy v25 FTS instead of rebuilding on every startup', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        workflow_run_id TEXT,
        step_index INTEGER,
        phase TEXT,
        label TEXT
      );
      CREATE VIRTUAL TABLE messages_fts
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE messages_fts_trigram
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');
      CREATE VIRTUAL TABLE dispatches_fts
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE dispatches_fts_trigram
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');
    `)
    for (let version = 1; version <= 28; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }
    db.prepare(
      `INSERT INTO messages (
        sequence, workspace_id, worker_id, type, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1, 'ws-1', 'worker-1', 'report', 'already healthy recall marker', 1)
    db.prepare(
      `INSERT INTO dispatches (
        sequence, id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      'dispatch-healthy',
      'ws-1',
      'orch-1',
      'worker-1',
      'already healthy dispatch marker',
      'reported',
      1,
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)').run(
      1,
      'already healthy recall marker'
    )
    db.prepare('INSERT INTO messages_fts_trigram(rowid, text) VALUES (?, ?)').run(
      1,
      'already healthy recall marker'
    )
    db.prepare('INSERT INTO dispatches_fts(rowid, text, report_text) VALUES (?, ?, ?)').run(
      1,
      'already healthy dispatch marker',
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO dispatches_fts_trigram(rowid, text, report_text) VALUES (?, ?, ?)').run(
      1,
      'already healthy dispatch marker',
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)').run(
      999,
      'sentinel stale rebuild marker'
    )
    db.prepare('INSERT INTO messages_fts_trigram(rowid, text) VALUES (?, ?)').run(
      999,
      'sentinel stale rebuild marker'
    )
    db.prepare('INSERT INTO dispatches_fts(rowid, text, report_text) VALUES (?, ?, ?)').run(
      999,
      'sentinel stale dispatch marker',
      null
    )
    db.prepare('INSERT INTO dispatches_fts_trigram(rowid, text, report_text) VALUES (?, ?, ?)').run(
      999,
      'sentinel stale dispatch marker',
      null
    )

    initializeRuntimeDatabase(db)

    expect(ftsHitCount(db, 'messages_fts', '"sentinel" AND "rebuild"')).toBe(1)
    expect(ftsHitCount(db, 'messages_fts_trigram', '"sen"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts', '"sentinel" AND "dispatch"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"sen"')).toBe(1)
    db.close()
  })

  test('runtime init does not rebuild v25 FTS when the first message is 2 chars', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        workflow_run_id TEXT,
        step_index INTEGER,
        phase TEXT,
        label TEXT
      );
      CREATE VIRTUAL TABLE messages_fts
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE messages_fts_trigram
        USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');
      CREATE VIRTUAL TABLE dispatches_fts
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
      CREATE VIRTUAL TABLE dispatches_fts_trigram
        USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');
    `)
    for (let version = 1; version <= 28; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }
    db.prepare(
      `INSERT INTO messages (
        sequence, workspace_id, worker_id, type, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1, 'ws-1', 'worker-1', 'user_input', 'ok', 1)
    db.prepare(
      `INSERT INTO dispatches (
        sequence, id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      'dispatch-short-msg',
      'ws-1',
      'orch-1',
      'worker-1',
      'already healthy dispatch marker',
      'reported',
      1,
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)').run(1, 'ok')
    db.prepare('INSERT INTO messages_fts_trigram(rowid, text) VALUES (?, ?)').run(1, 'ok')
    db.prepare('INSERT INTO dispatches_fts(rowid, text, report_text) VALUES (?, ?, ?)').run(
      1,
      'already healthy dispatch marker',
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO dispatches_fts_trigram(rowid, text, report_text) VALUES (?, ?, ?)').run(
      1,
      'already healthy dispatch marker',
      'already healthy dispatch report'
    )
    db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)').run(
      999,
      'sentinel stale rebuild marker'
    )
    db.prepare('INSERT INTO messages_fts_trigram(rowid, text) VALUES (?, ?)').run(
      999,
      'sentinel stale rebuild marker'
    )
    db.prepare('INSERT INTO dispatches_fts(rowid, text, report_text) VALUES (?, ?, ?)').run(
      999,
      'sentinel stale dispatch marker',
      null
    )
    db.prepare('INSERT INTO dispatches_fts_trigram(rowid, text, report_text) VALUES (?, ?, ?)').run(
      999,
      'sentinel stale dispatch marker',
      null
    )

    initializeRuntimeDatabase(db)

    expect(ftsHitCount(db, 'messages_fts', '"sentinel" AND "rebuild"')).toBe(1)
    expect(ftsHitCount(db, 'messages_fts_trigram', '"sen"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts', '"sentinel" AND "dispatch"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"sen"')).toBe(1)
    db.close()
  })

  test('v26 creates workspace-owned memory tables without worker ownership foreign keys', () => {
    const db = new Database(':memory:')

    applySchemaVersion26(db)

    const entryColumns = new Set(
      (db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const sourceColumns = new Set(
      (db.prepare('PRAGMA table_info(memory_sources)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const injectionColumns = new Set(
      (db.prepare('PRAGMA table_info(memory_injections)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const entryIndexes = new Set(
      (db.prepare('PRAGMA index_list(memory_entries)').all() as Array<{ name: string }>).map(
        (index) => index.name
      )
    )
    const foreignTables = [
      ...(db.prepare('PRAGMA foreign_key_list(memory_entries)').all() as Array<{ table: string }>),
      ...(db.prepare('PRAGMA foreign_key_list(memory_sources)').all() as Array<{ table: string }>),
      ...(db.prepare('PRAGMA foreign_key_list(memory_injections)').all() as Array<{
        table: string
      }>),
    ].map((row) => row.table)

    expect(entryColumns).toEqual(
      new Set([
        'id',
        'workspace_id',
        'scope',
        'fts_rowid',
        'kind',
        'body',
        'tags',
        'status',
        'source',
        'confidence',
        'pinned',
        'disabled',
        'created_at',
        'updated_at',
        'archived_at',
        'last_injected_at',
      ])
    )
    expect(sourceColumns.has('actor_agent_id_snapshot')).toBe(true)
    expect(sourceColumns.has('actor_name_snapshot')).toBe(true)
    expect(sourceColumns.has('actor_role_snapshot')).toBe(true)
    expect(injectionColumns.has('target_agent_id_snapshot')).toBe(true)
    expect(entryIndexes.has('idx_memory_entries_ws_status')).toBe(true)
    expect(foreignTables).not.toContain('workers')
    expect(foreignTables).not.toContain('role_templates')

    db.close()
  })

  test('v36 adds structured procedure reference columns to memory entries', () => {
    const db = new Database(':memory:')
    applySchemaVersion26(db)

    applySchemaVersion36(db)
    applySchemaVersion36(db)

    const entryColumns = new Set(
      (db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const entryIndexes = new Set(
      (db.prepare('PRAGMA index_list(memory_entries)').all() as Array<{ name: string }>).map(
        (index) => index.name
      )
    )
    expect(entryColumns.has('ref_type')).toBe(true)
    expect(entryColumns.has('ref_id')).toBe(true)
    expect(entryColumns.has('ref_title')).toBe(true)
    expect(entryIndexes.has('idx_memory_entries_ref')).toBe(true)

    db.close()
  })

  test('v27 backfills and maintains memory FTS, including CJK trigram search', () => {
    const db = new Database(':memory:')
    applySchemaVersion26(db)

    db.prepare(
      `INSERT INTO memory_entries (
        id,
        workspace_id,
        scope,
        fts_rowid,
        kind,
        body,
        tags,
        status,
        source,
        confidence,
        pinned,
        disabled,
        created_at,
        updated_at
      ) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?, 'manual', ?, 0, 0, ?, ?)`
    ).run(
      'memory-1',
      'ws-1',
      1,
      'decision',
      'Remote mobile API calls must use the E2E relay path.',
      JSON.stringify(['remote', 'relay']),
      'active',
      1,
      1,
      1
    )
    db.prepare(
      `INSERT INTO memory_entries (
        id,
        workspace_id,
        scope,
        fts_rowid,
        kind,
        body,
        tags,
        status,
        source,
        confidence,
        pinned,
        disabled,
        created_at,
        updated_at
      ) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?, 'manual', ?, 0, 0, ?, ?)`
    ).run(
      'memory-2',
      'ws-1',
      2,
      'pitfall',
      '移动端访问链必须经过 relay。',
      JSON.stringify(['访问链']),
      'active',
      1,
      1,
      1
    )

    applySchemaVersion27(db)

    expect(ftsHitCount(db, 'memory_fts', '"remote" AND "relay"')).toBe(1)
    expect(ftsHitCount(db, 'memory_fts_trigram', '"访问链"')).toBe(1)

    const inserted = db
      .prepare(
        `INSERT INTO memory_entries (
          id,
          workspace_id,
          scope,
          fts_rowid,
          kind,
          body,
          tags,
          status,
          source,
          pinned,
          disabled,
          created_at,
          updated_at
        ) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?, 'manual', 0, 0, ?, ?)`
      )
      .run(
        'memory-3',
        'ws-1',
        3,
        'fact',
        'fresh memory search marker',
        JSON.stringify([]),
        'active',
        2,
        2
      )
    expect(Number(inserted.changes)).toBe(1)
    expect(ftsHitCount(db, 'memory_fts', '"fresh" AND "marker"')).toBe(1)

    db.prepare('UPDATE memory_entries SET body = ?, updated_at = ? WHERE id = ?').run(
      'updated memory search marker',
      3,
      'memory-3'
    )
    expect(ftsHitCount(db, 'memory_fts', '"fresh" AND "marker"')).toBe(0)
    expect(ftsHitCount(db, 'memory_fts', '"updated" AND "marker"')).toBe(1)

    db.prepare('DELETE FROM memory_entries WHERE id = ?').run('memory-3')
    expect(ftsHitCount(db, 'memory_fts', '"updated" AND "marker"')).toBe(0)

    db.close()
  })

  test('runtime init rebuilds v27 memory FTS when schema_version already contains 27', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    for (let version = 1; version <= 27; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }
    applySchemaVersion26(db)
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts
        USING fts5(body, tags, content='memory_entries', content_rowid='fts_rowid', tokenize='unicode61');
      CREATE VIRTUAL TABLE memory_fts_trigram
        USING fts5(body, tags, content='memory_entries', content_rowid='fts_rowid', tokenize='trigram');
    `)
    db.prepare(
      `INSERT INTO memory_entries (
        id,
        workspace_id,
        scope,
        fts_rowid,
        kind,
        body,
        tags,
        status,
        source,
        pinned,
        disabled,
        created_at,
        updated_at
      ) VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?, 'manual', 0, 0, ?, ?)`
    ).run(
      'memory-stamped',
      'ws-1',
      1,
      'fact',
      'already stamped memory marker',
      JSON.stringify([]),
      'active',
      1,
      1
    )
    db.prepare('INSERT INTO memory_fts(rowid, body, tags) VALUES (?, ?, ?)').run(
      1,
      'already stamped memory marker',
      JSON.stringify([])
    )

    initializeRuntimeDatabase(db)

    expect(ftsHitCount(db, 'memory_fts', '"stamped" AND "marker"')).toBe(1)
    expect(ftsHitCount(db, 'memory_fts_trigram', '"sta"')).toBe(1)
    db.close()
  })

  test('migration updates builtin Claude yolo args for existing databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-claude-yolo-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO command_presets (
        id,
        display_name,
        command,
        args,
        env,
        resume_args_template,
        session_id_capture,
        yolo_args_template,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'claude',
      'Claude Code (CC)',
      'claude',
      '[]',
      '{}',
      '[]',
      null,
      JSON.stringify(['--dangerously-skip-permissions']),
      1,
      1,
      1
    )

    initializeRuntimeDatabase(db)

    const preset = db
      .prepare('SELECT yolo_args_template FROM command_presets WHERE id = ?')
      .get('claude') as { yolo_args_template: string } | undefined
    const version = db.prepare('SELECT version FROM schema_version WHERE version = ?').get(9) as
      | { version: number }
      | undefined

    expect(JSON.parse(preset?.yolo_args_template ?? '[]')).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
    ])
    expect(version).toEqual({ version: 9 })

    db.close()
  })

  test('migration updates builtin resume support for all supported agent presets', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-agent-resume-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(
      `INSERT INTO command_presets (
        id,
        display_name,
        command,
        args,
        env,
        resume_args_template,
        session_id_capture,
        yolo_args_template,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, displayName, command] of [
      ['claude', 'Claude Code (CC)', 'claude'],
      ['codex', 'Codex', 'codex'],
      ['opencode', 'OpenCode', 'opencode'],
      ['gemini', 'Gemini', 'gemini'],
    ] as const) {
      insert.run(id, displayName, command, '[]', '{}', null, null, null, 1, 1, 1)
    }

    initializeRuntimeDatabase(db)

    const rows = db
      .prepare(
        'SELECT id, resume_args_template, session_id_capture, yolo_args_template FROM command_presets ORDER BY id'
      )
      .all() as Array<{
      id: string
      resume_args_template: string | null
      session_id_capture: string | null
      yolo_args_template: string | null
    }>
    const byId = Object.fromEntries(rows.map((row) => [row.id, row])) as Record<
      string,
      (typeof rows)[number] | undefined
    >
    const expectPreset = (id: string) => {
      const row = byId[id]
      expect(row).toBeDefined()
      return row as (typeof rows)[number]
    }

    const claude = expectPreset('claude')
    const codex = expectPreset('codex')
    const gemini = expectPreset('gemini')
    const hermes = expectPreset('hermes')
    const opencode = expectPreset('opencode')

    expect(claude.resume_args_template).toBe('--resume {session_id}')
    expect(JSON.parse(claude.session_id_capture ?? '{}')).toMatchObject({
      source: 'claude_project_jsonl_dir',
    })
    expect(codex.resume_args_template).toBe('resume {session_id}')
    expect(JSON.parse(codex.session_id_capture ?? '{}')).toMatchObject({
      source: 'codex_session_jsonl_dir',
    })
    expect(JSON.parse(codex.yolo_args_template ?? '[]')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(gemini.resume_args_template).toBe('--resume {session_id}')
    expect(JSON.parse(gemini.session_id_capture ?? '{}')).toMatchObject({
      source: 'gemini_session_json_dir',
    })
    expect(JSON.parse(gemini.yolo_args_template ?? '[]')).toEqual(['--yolo'])
    expect(hermes.resume_args_template).toBe('--resume {session_id}')
    expect(JSON.parse(hermes.session_id_capture ?? '{}')).toMatchObject({
      source: 'stdout_regex',
    })
    expect(JSON.parse(hermes.yolo_args_template ?? '[]')).toEqual(['--yolo'])
    expect(opencode.resume_args_template).toBe('--session {session_id}')
    expect(JSON.parse(opencode.session_id_capture ?? '{}')).toMatchObject({
      source: 'opencode_session_db',
    })
    expect(JSON.parse(opencode.yolo_args_template ?? '[]')).toEqual([])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(10)).toEqual({
      version: 10,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(11)).toEqual({
      version: 11,
    })

    db.close()
  })

  test('migration inserts Hermes builtin preset for existing databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-hermes-preset-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13), (14, 14), (15, 15), (16, 16), (17, 17), (18, 18), (19, 19), (20, 20), (21, 21);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    initializeRuntimeDatabase(db)

    const hermes = db
      .prepare(
        'SELECT id, display_name, command, args, env, resume_args_template, session_id_capture, yolo_args_template, is_builtin FROM command_presets WHERE id = ?'
      )
      .get('hermes') as
      | {
          id: string
          display_name: string
          command: string
          args: string
          env: string
          resume_args_template: string | null
          session_id_capture: string | null
          yolo_args_template: string | null
          is_builtin: number
        }
      | undefined

    expect(hermes).toMatchObject({
      args: '[]',
      command: 'hermes',
      display_name: 'Hermes',
      env: '{}',
      id: 'hermes',
      is_builtin: 1,
      resume_args_template: '--resume {session_id}',
    })
    expect(JSON.parse(hermes?.session_id_capture ?? '{}')).toMatchObject({
      source: 'stdout_regex',
    })
    expect(JSON.parse(hermes?.yolo_args_template ?? '[]')).toEqual(['--yolo'])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(22)).toEqual({
      version: 22,
    })

    db.close()
  })

  test('migration preserves a user-defined Hermes preset id conflict', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-hermes-custom-preset-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13), (14, 14), (15, 15), (16, 16), (17, 17), (18, 18), (19, 19), (20, 20), (21, 21);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO command_presets (
        id, display_name, command, args, env, resume_args_template, session_id_capture,
        yolo_args_template, is_builtin, created_at, updated_at
      ) VALUES (
        'hermes', 'Custom Hermes', 'custom-hermes', '["--custom"]', '{}',
        '--custom-resume {session_id}', NULL, '[]', 0, 42, 43
      );
    `)

    initializeRuntimeDatabase(db)

    const hermes = db
      .prepare(
        'SELECT id, display_name, command, args, resume_args_template, yolo_args_template, is_builtin, updated_at FROM command_presets WHERE id = ?'
      )
      .get('hermes') as
      | {
          id: string
          display_name: string
          command: string
          args: string
          resume_args_template: string | null
          yolo_args_template: string | null
          is_builtin: number
          updated_at: number
        }
      | undefined

    expect(hermes).toEqual({
      args: '["--custom"]',
      command: 'custom-hermes',
      display_name: 'Custom Hermes',
      id: 'hermes',
      is_builtin: 0,
      resume_args_template: '--custom-resume {session_id}',
      updated_at: 43,
      yolo_args_template: '[]',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(22)).toEqual({
      version: 22,
    })

    db.close()
  })

  test('migration updates builtin yolo args for existing v10 databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-agent-yolo-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(
      `INSERT INTO command_presets (
        id,
        display_name,
        command,
        args,
        env,
        resume_args_template,
        session_id_capture,
        yolo_args_template,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, displayName, command] of [
      ['claude', 'Claude Code (CC)', 'claude'],
      ['codex', 'Codex', 'codex'],
      ['opencode', 'OpenCode', 'opencode'],
      ['gemini', 'Gemini', 'gemini'],
    ] as const) {
      insert.run(id, displayName, command, '[]', '{}', null, null, null, 1, 1, 1)
    }

    initializeRuntimeDatabase(db)

    const rows = db
      .prepare('SELECT id, yolo_args_template FROM command_presets ORDER BY id')
      .all() as Array<{ id: string; yolo_args_template: string | null }>
    const byId = Object.fromEntries(
      rows.map((row) => [row.id, JSON.parse(row.yolo_args_template ?? '[]') as string[]])
    )

    expect(byId.claude).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
    ])
    expect(byId.codex).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(byId.gemini).toEqual(['--yolo'])
    expect(byId.opencode).toEqual([])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(11)).toEqual({
      version: 11,
    })

    db.close()
  })

  test('migration clears builtin OpenCode yolo args for existing v16 databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-opencode-yolo-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13), (14, 14), (15, 15), (16, 16);

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(
      `INSERT INTO command_presets (
        id,
        display_name,
        command,
        args,
        env,
        resume_args_template,
        session_id_capture,
        yolo_args_template,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, displayName, command, yoloArgs] of [
      [
        'claude',
        'Claude Code (CC)',
        'claude',
        [
          '--dangerously-skip-permissions',
          '--permission-mode=bypassPermissions',
          '--disallowedTools=Task',
        ],
      ],
      ['codex', 'Codex', 'codex', ['--dangerously-bypass-approvals-and-sandbox']],
      ['opencode', 'OpenCode', 'opencode', ['--dangerously-skip-permissions']],
      ['gemini', 'Gemini', 'gemini', ['--yolo']],
    ] as const) {
      insert.run(
        id,
        displayName,
        command,
        '[]',
        '{}',
        null,
        null,
        JSON.stringify(yoloArgs),
        1,
        1,
        1
      )
    }
    insert.run(
      'custom-opencode',
      'Custom OpenCode',
      'opencode',
      '[]',
      '{}',
      null,
      null,
      JSON.stringify(['--dangerously-skip-permissions']),
      0,
      1,
      1
    )

    initializeRuntimeDatabase(db)

    const rows = db
      .prepare('SELECT id, yolo_args_template FROM command_presets ORDER BY id')
      .all() as Array<{ id: string; yolo_args_template: string | null }>
    const byId = Object.fromEntries(
      rows.map((row) => [row.id, JSON.parse(row.yolo_args_template ?? '[]') as string[]])
    )

    expect(byId.claude).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
    ])
    expect(byId.codex).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(byId.gemini).toEqual(['--yolo'])
    expect(byId.opencode).toEqual([])
    expect(byId['custom-opencode']).toEqual(['--dangerously-skip-permissions'])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(18)).toEqual({
      version: 18,
    })

    db.close()
  })

  test('migration updates builtin role template descriptions for existing databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-role-template-descriptions-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11);

      CREATE TABLE role_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role_type TEXT NOT NULL,
        description TEXT NOT NULL,
        default_command TEXT NOT NULL,
        default_args TEXT NOT NULL,
        default_env TEXT NOT NULL,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(
      `INSERT INTO role_templates (
        id,
        name,
        role_type,
        description,
        default_command,
        default_args,
        default_env,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, name, roleType, description] of [
      ['orchestrator', 'Orchestrator', 'orchestrator', 'old orch'],
      ['coder', 'Coder', 'coder', 'old coder'],
      ['reviewer', 'Reviewer', 'reviewer', 'old reviewer'],
      ['tester', 'Tester', 'tester', 'old tester'],
    ] as const) {
      insert.run(id, name, roleType, description, 'claude', '[]', '{}', 1, 1, 1)
    }

    initializeRuntimeDatabase(db)

    const rows = db
      .prepare('SELECT id, description FROM role_templates ORDER BY id')
      .all() as Array<{ description: string; id: string }>
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.description]))

    expect(byId.coder).toContain('You are an implementation Coder')
    expect(byId.coder).toContain('Read relevant files and existing patterns')
    expect(byId.reviewer).toContain('You are a Reviewer')
    expect(byId.reviewer).toContain('blocking issues first')
    expect(byId.tester).toContain('You are a Tester')
    expect(byId.orchestrator).toContain('You are the Hive Orchestrator')
    expect(byId.orchestrator).toContain('.hive/tasks.md')
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(12)).toEqual({
      version: 12,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(13)).toEqual({
      version: 13,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(35)).toEqual({
      version: 35,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration refreshes v12 builtin role prompts to .hive tasks path', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v13-role-template-descriptions-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12);

      CREATE TABLE role_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role_type TEXT NOT NULL,
        description TEXT NOT NULL,
        default_command TEXT NOT NULL,
        default_args TEXT NOT NULL,
        default_env TEXT NOT NULL,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO role_templates (
        id,
        name,
        role_type,
        description,
        default_command,
        default_args,
        default_env,
        is_builtin,
        created_at,
        updated_at
      )
      VALUES (
        'orchestrator',
        'Orchestrator',
        'orchestrator',
        '你是 Hive 的 Orchestrator。维护 tasks.md。',
        'claude',
        '[]',
        '{}',
        1,
        1,
        1
      );
    `)

    initializeRuntimeDatabase(db)

    const row = db
      .prepare('SELECT description FROM role_templates WHERE id = ?')
      .get('orchestrator') as { description: string }
    expect(row.description).toContain('.hive/tasks.md')
    expect(row.description).not.toContain('维护 tasks.md')
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(13)).toEqual({
      version: 13,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration backfills dispatch ledger from legacy send and report messages', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v14-dispatch-backfill-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13);

      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('ws-1', 'worker-1', 'send', 'orch-1', 'worker-1', 'task 1', null, null, 100)
    insert.run('ws-1', 'worker-1', 'send', 'orch-1', 'worker-1', 'task 2', null, null, 200)
    insert.run(
      'ws-1',
      'worker-1',
      'report',
      'worker-1',
      'orch-1',
      'done 1',
      null,
      JSON.stringify(['src/a.ts']),
      300
    )

    initializeRuntimeDatabase(db)

    const dispatches = db
      .prepare(
        'SELECT workspace_id, to_agent_id, text, status, reported_at, report_text, artifacts FROM dispatches ORDER BY sequence'
      )
      .all() as Array<{
      artifacts: string
      reported_at: number | null
      report_text: string | null
      status: string
      text: string
      to_agent_id: string
      workspace_id: string
    }>

    expect(dispatches).toEqual([
      {
        artifacts: JSON.stringify(['src/a.ts']),
        reported_at: 300,
        report_text: 'done 1',
        status: 'reported',
        text: 'task 1',
        to_agent_id: 'worker-1',
        workspace_id: 'ws-1',
      },
      {
        artifacts: '[]',
        reported_at: null,
        report_text: null,
        status: 'queued',
        text: 'task 2',
        to_agent_id: 'worker-1',
        workspace_id: 'ws-1',
      },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration repairs v14 dispatch tables that were created without sequence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v15-dispatch-sequence-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13), (14, 14);

      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );

      CREATE INDEX idx_dispatches_workspace_created_at
        ON dispatches (workspace_id, created_at);

      CREATE INDEX idx_dispatches_open_by_worker
        ON dispatches (workspace_id, to_agent_id, status, created_at);
    `)
    db.prepare(
      `INSERT INTO dispatches (
         id,
         workspace_id,
         from_agent_id,
         to_agent_id,
         text,
         status,
         created_at,
         delivered_at,
         submitted_at,
         reported_at,
         report_text,
         artifacts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-2',
      'ws-1',
      'orch-1',
      'worker-1',
      'second',
      'submitted',
      200,
      210,
      220,
      null,
      null,
      '[]'
    )
    db.prepare(
      `INSERT INTO dispatches (
         id,
         workspace_id,
         from_agent_id,
         to_agent_id,
         text,
         status,
         created_at,
         delivered_at,
         submitted_at,
         reported_at,
         report_text,
         artifacts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-1',
      'ws-1',
      'orch-1',
      'worker-1',
      'first',
      'reported',
      100,
      110,
      120,
      130,
      'done',
      '["a.md"]'
    )

    initializeRuntimeDatabase(db)

    const dispatchColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const rows = db
      .prepare('SELECT sequence, id, text FROM dispatches ORDER BY sequence ASC')
      .all() as Array<{ id: string; sequence: number; text: string }>

    expect(dispatchColumns.has('sequence')).toBe(true)
    expect(rows).toEqual([
      { id: 'dispatch-1', sequence: 1, text: 'first' },
      { id: 'dispatch-2', sequence: 2, text: 'second' },
    ])
    expect(indexColumns(db, 'idx_dispatches_workspace_created_at')).toEqual([
      'workspace_id',
      'sequence',
    ])
    expect(indexColumns(db, 'idx_dispatches_open_by_worker')).toEqual([
      'workspace_id',
      'to_agent_id',
      'status',
      'sequence',
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(15)).toEqual({
      version: 15,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(16)).toEqual({
      version: 16,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(17)).toEqual({
      version: 17,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(18)).toEqual({
      version: 18,
    })

    db.close()
  })

  test('boot recovers a v15 half-state (legacy table present, live table empty)', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9),
             (10, 10), (11, 11), (12, 12), (13, 13), (14, 14);

      CREATE TABLE dispatches_legacy_v15 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );
    `)
    db.prepare(
      `INSERT INTO dispatches_legacy_v15 (
         id, workspace_id, from_agent_id, to_agent_id, text, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('d1', 'ws-1', 'orch-1', 'worker-1', 'important-history', 'reported', 100)

    initializeRuntimeDatabase(db)

    const live = db
      .prepare('SELECT id, text FROM dispatches ORDER BY sequence ASC')
      .all() as Array<{ id: string; text: string }>
    const legacy = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatches_legacy_v15'"
      )
      .get()
    expect(live).toEqual([{ id: 'd1', text: 'important-history' }])
    expect(legacy).toBeUndefined()
    db.close()
  })

  test('boot recovers a v15 half-state even after version 15 was stamped', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9),
             (10, 10), (11, 11), (12, 12), (13, 13), (14, 14), (15, 15);

      CREATE TABLE dispatches_legacy_v15 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );
    `)
    db.prepare(
      `INSERT INTO dispatches_legacy_v15 (
         id, workspace_id, from_agent_id, to_agent_id, text, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('d1', 'ws-1', 'orch-1', 'worker-1', 'important-history', 'reported', 100)

    initializeRuntimeDatabase(db)

    const live = db
      .prepare('SELECT id, text FROM dispatches ORDER BY sequence ASC')
      .all() as Array<{ id: string; text: string }>
    expect(live).toEqual([{ id: 'd1', text: 'important-history' }])
    db.close()
  })

  test('v23 creates the remote_audit table with the audit-spec columns', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v23-remote-audit-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
    const auditColumns = new Set(
      (db.prepare('PRAGMA table_info(remote_audit)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const auditIndexes = new Set(
      (db.prepare('PRAGMA index_list(remote_audit)').all() as Array<{ name: string }>).map(
        (index) => index.name
      )
    )

    expect(auditColumns).toEqual(
      new Set([
        'id',
        'remote_device_id',
        'ts',
        'workspace_id',
        'action',
        'endpoint',
        'result',
        'reject_reason',
        'byte_count',
        'preview',
      ])
    )
    expect(auditIndexes.has('idx_remote_audit_recent')).toBe(true)
    expect(auditIndexes.has('idx_remote_audit_device')).toBe(true)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(23)).toEqual({
      version: 23,
    })

    db.close()
  })

  test('v24 creates the remote_devices table with the device-store columns and index', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v24-remote-devices-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
    const deviceColumns = new Set(
      (db.prepare('PRAGMA table_info(remote_devices)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const deviceIndexes = new Set(
      (db.prepare('PRAGMA index_list(remote_devices)').all() as Array<{ name: string }>).map(
        (index) => index.name
      )
    )

    expect(deviceColumns).toEqual(
      new Set([
        'id',
        'name',
        'key_d2p',
        'key_p2d',
        'device_pubkey',
        'created_at',
        'last_active',
        'revoked_at',
      ])
    )
    expect(deviceIndexes.has('idx_remote_devices_active')).toBe(true)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(24)).toEqual({
      version: 24,
    })

    db.close()
  })

  test('migration upgrades legacy messages.kind data into messages.type', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-migrate-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at) VALUES (1, 1), (2, 2), (3, 3), (4, 4);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         kind,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ws-1', 'worker-1', 'send', 'send', 'orch-1', 'worker-1', 'hello', null, null, 123)

    initializeRuntimeDatabase(db)

    const migratedColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const message = db
      .prepare('SELECT type, text FROM messages WHERE workspace_id = ?')
      .get('ws-1') as { text: string; type: string } | undefined

    expect(migratedColumns.has('kind')).toBe(false)
    expect(message).toEqual({ type: 'send', text: 'hello' })
    db.close()
  })

  test('migration from v36 creates external goal tables and stamps v37', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)

    for (let version = 1; version <= 36; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    initializeRuntimeDatabase(db)

    expect(tableColumns(db, 'external_goal_sessions')).toEqual(
      new Set([
        'id',
        'workspace_id',
        'source',
        'goal',
        'context_json',
        'status',
        'title',
        'summary',
        'created_at',
        'updated_at',
        'closed_at',
      ])
    )
    expect(tableColumns(db, 'external_goal_events')).toEqual(
      new Set([
        'sequence',
        'id',
        'goal_id',
        'workspace_id',
        'kind',
        'status',
        'body',
        'artifacts_json',
        'created_at',
      ])
    )
    expect(tableIndexes(db, 'external_goal_events').has('idx_external_goal_events_goal')).toBe(true)
    expect(indexColumns(db, 'idx_external_goal_events_goal')).toEqual(['goal_id', 'sequence'])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(37)).toEqual({
      version: 37,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(38)).toEqual({
      version: 38,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(39)).toEqual({
      version: 39,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(40)).toEqual({
      version: 40,
    })
    expect(CURRENT_SCHEMA_VERSION).toBe(46)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 41').get()).toEqual({
      version: 41,
    })
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version >= 42 ORDER BY version').all()
    ).toEqual([{ version: 42 }, { version: 43 }, { version: 44 }, { version: 45 }, { version: 46 }])

    db.close()
  })

  test('migration from v37 inserts Pi builtin preset and stamps v38', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    for (let version = 1; version <= 37; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    initializeRuntimeDatabase(db)

    const pi = db
      .prepare(
        'SELECT id, display_name, command, args, env, resume_args_template, session_id_capture, yolo_args_template, is_builtin FROM command_presets WHERE id = ?'
      )
      .get('pi') as
      | {
          id: string
          display_name: string
          command: string
          args: string
          env: string
          resume_args_template: string | null
          session_id_capture: string | null
          yolo_args_template: string | null
          is_builtin: number
        }
      | undefined

    expect(pi).toEqual({
      args: '[]',
      command: 'pi',
      display_name: 'Pi',
      env: '{}',
      id: 'pi',
      is_builtin: 1,
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: '["--approve"]',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(38)).toEqual({
      version: 38,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(39)).toEqual({
      version: 39,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(40)).toEqual({
      version: 40,
    })

    db.close()
  })

  test('migration from v38 adds worker avatar column and stamps v39/v40', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        last_session_id TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    for (let version = 1; version <= 38; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    initializeRuntimeDatabase(db)

    expect(tableColumns(db, 'workers').has('avatar')).toBe(true)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(39)).toEqual({
      version: 39,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(40)).toEqual({
      version: 40,
    })

    db.close()
  })

  test('migration from v39 removes retired Sentinel templates and workers', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE role_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role_type TEXT NOT NULL,
        description TEXT NOT NULL,
        default_command TEXT NOT NULL,
        default_args TEXT NOT NULL,
        default_env TEXT NOT NULL,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        avatar TEXT,
        last_session_id TEXT,
        role TEXT NOT NULL,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        spawned_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );

      CREATE TABLE report_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );

      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        command_preset_id TEXT,
        interactive_command TEXT,
        preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
        resume_args_template TEXT,
        session_id_capture_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE TABLE agent_sessions (
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        last_session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO role_templates (
        id, name, role_type, description, default_command, default_args, default_env,
        is_builtin, created_at, updated_at
      ) VALUES
        ('sentinel', 'Sentinel', 'sentinel', 'observe', 'claude', '[]', '{}', 1, 1, 1),
        ('coder', 'Coder', 'coder', 'code', 'claude', '[]', '{}', 1, 1, 1);

      INSERT INTO workspaces (id, name, path, created_at)
      VALUES ('ws', 'WS', '/tmp/ws', 1);

      INSERT INTO workers (
        id, workspace_id, name, description, avatar, last_session_id, role,
        ephemeral, spawned_by, created_at
      ) VALUES
        ('sentinel-worker', 'ws', 'argus', 'observe', NULL, NULL, 'sentinel', 0, NULL, 1),
        ('coder-worker', 'ws', 'ada', 'code', NULL, NULL, 'coder', 0, NULL, 1);

      INSERT INTO messages (
        workspace_id, worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
      ) VALUES
        ('ws', 'sentinel-worker', 'status', 'sentinel-worker', 'ws:orchestrator', 'patrol', NULL, '[]', 1),
        ('ws', 'coder-worker', 'status', 'coder-worker', 'ws:orchestrator', 'ready', NULL, '[]', 1);

      INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, artifacts
      ) VALUES
        ('dispatch-sentinel', 'ws', 'ws:orchestrator', 'sentinel-worker', 'watch', 'queued', 1, '[]'),
        ('dispatch-coder', 'ws', 'ws:orchestrator', 'coder-worker', 'code', 'queued', 1, '[]');

      INSERT INTO report_outbox (
        workspace_id, target_agent_id, dispatch_id, payload, created_at, delivered_at
      ) VALUES
        ('ws', 'sentinel-worker', 'dispatch-sentinel', '{}', 1, NULL),
        ('ws', 'coder-worker', 'dispatch-coder', '{}', 1, NULL);

      INSERT INTO agent_launch_configs (
        workspace_id, agent_id, command, args_json, created_at, updated_at
      ) VALUES
        ('ws', 'sentinel-worker', 'claude', '[]', 1, 1),
        ('ws', 'coder-worker', 'claude', '[]', 1, 1);

      INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at)
      VALUES
        ('sentinel-worker', 'ws', 'session-sentinel', 1),
        ('coder-worker', 'ws', 'session-coder', 1);

      INSERT INTO agent_runs (
        run_id, agent_id, status, started_at, created_at, updated_at
      ) VALUES
        ('run-sentinel', 'sentinel-worker', 'running', 1, 1, 1),
        ('run-coder', 'coder-worker', 'running', 1, 1, 1);
    `)

    for (let version = 1; version <= 39; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    initializeRuntimeDatabase(db)

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM role_templates WHERE role_type = 'sentinel'").get()
    ).toEqual({ count: 0 })
    expect(db.prepare('SELECT role FROM workers ORDER BY id').all()).toEqual([{ role: 'coder' }])
    expect(db.prepare('SELECT worker_id FROM messages ORDER BY worker_id').all()).toEqual([
      { worker_id: 'coder-worker' },
    ])
    expect(db.prepare('SELECT id FROM dispatches ORDER BY id').all()).toEqual([
      { id: 'dispatch-coder' },
    ])
    expect(db.prepare('SELECT dispatch_id FROM report_outbox ORDER BY dispatch_id').all()).toEqual([
      { dispatch_id: 'dispatch-coder' },
    ])
    expect(db.prepare('SELECT agent_id FROM agent_launch_configs ORDER BY agent_id').all()).toEqual(
      [{ agent_id: 'coder-worker' }]
    )
    expect(db.prepare('SELECT agent_id FROM agent_sessions ORDER BY agent_id').all()).toEqual([
      { agent_id: 'coder-worker' },
    ])
    expect(db.prepare('SELECT agent_id FROM agent_runs ORDER BY agent_id').all()).toEqual([
      { agent_id: 'coder-worker' },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(40)).toEqual({
      version: 40,
    })

    db.close()
  })

  test('v40 removes retired Sentinel rows through the production FTS triggers', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = 40').run()

    db.prepare(
      `INSERT INTO role_templates (
        id, name, role_type, description, default_command, default_args, default_env,
        is_builtin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run('sentinel', 'Sentinel', 'sentinel', 'observe', 'claude', '[]', '{}', 1, 1)
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'ws',
      'WS',
      '/tmp/ws',
      1
    )
    db.prepare(
      `INSERT INTO workers (
        id, workspace_id, name, description, role, created_at, ephemeral, spawned_by
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`
    ).run('sentinel-worker', 'ws', 'argus', 'observe', 'sentinel', 1)
    db.prepare(
      `INSERT INTO workers (
        id, workspace_id, name, description, role, created_at, ephemeral, spawned_by
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`
    ).run('coder-worker', 'ws', 'ada', 'code', 'coder', 1)
    db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(
      'ws',
      'sentinel-worker',
      'status',
      'sentinel-worker',
      'ws:orchestrator',
      'retired sentinel patrol marker',
      '[]',
      1
    )
    db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(
      'ws',
      'coder-worker',
      'status',
      'coder-worker',
      'ws:orchestrator',
      'coder healthy marker',
      '[]',
      1
    )
    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text, artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-sentinel',
      'ws',
      'ws:orchestrator',
      'sentinel-worker',
      'sentinel dispatch cleanup marker',
      'reported',
      1,
      'sentinel report cleanup marker',
      '[]'
    )
    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text, artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-coder',
      'ws',
      'ws:orchestrator',
      'coder-worker',
      'coder dispatch marker',
      'reported',
      1,
      'coder report marker',
      '[]'
    )
    db.prepare(
      `INSERT INTO report_outbox (
        workspace_id, target_agent_id, dispatch_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('ws', 'sentinel-worker', 'dispatch-sentinel', '{}', 1)

    expect(ftsHitCount(db, 'messages_fts', '"sentinel" AND "patrol"')).toBe(1)
    expect(ftsHitCount(db, 'messages_fts_trigram', '"sen"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts', '"sentinel" AND "cleanup"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"sen"')).toBe(1)

    initializeRuntimeDatabase(db)

    expect(ftsHitCount(db, 'messages_fts', '"sentinel" AND "patrol"')).toBe(0)
    expect(ftsHitCount(db, 'messages_fts_trigram', '"sen"')).toBe(0)
    expect(ftsHitCount(db, 'dispatches_fts', '"sentinel" AND "cleanup"')).toBe(0)
    expect(ftsHitCount(db, 'dispatches_fts_trigram', '"sen"')).toBe(0)
    expect(ftsHitCount(db, 'messages_fts', '"coder" AND "healthy"')).toBe(1)
    expect(ftsHitCount(db, 'dispatches_fts', '"coder" AND "dispatch"')).toBe(1)
    expect(db.prepare('SELECT id FROM workers ORDER BY id').all()).toEqual([{ id: 'coder-worker' }])
    expect(db.prepare('SELECT id FROM dispatches ORDER BY id').all()).toEqual([
      { id: 'dispatch-coder' },
    ])
    expect(db.prepare('SELECT dispatch_id FROM report_outbox').all()).toEqual([])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 40').get()).toEqual({
      version: 40,
    })

    db.close()
  })

  test('migration preserves a user-defined Pi preset id conflict', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE command_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        resume_args_template TEXT,
        session_id_capture TEXT,
        yolo_args_template TEXT,
        is_builtin INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO command_presets (
        id, display_name, command, args, env, resume_args_template, session_id_capture,
        yolo_args_template, is_builtin, created_at, updated_at
      ) VALUES (
        'pi', 'Custom Pi', 'custom-pi', '["--custom"]', '{}',
        '--custom-session {session_id}', NULL, '[]', 0, 42, 43
      );
    `)

    for (let version = 1; version <= 37; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    initializeRuntimeDatabase(db)

    const pi = db
      .prepare(
        'SELECT id, display_name, command, args, resume_args_template, yolo_args_template, is_builtin, updated_at FROM command_presets WHERE id = ?'
      )
      .get('pi')

    expect(pi).toEqual({
      args: '["--custom"]',
      command: 'custom-pi',
      display_name: 'Custom Pi',
      id: 'pi',
      is_builtin: 0,
      resume_args_template: '--custom-session {session_id}',
      updated_at: 43,
      yolo_args_template: '[]',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(38)).toEqual({
      version: 38,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(39)).toEqual({
      version: 39,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(40)).toEqual({
      version: 40,
    })

    db.close()
  })

  test('migration from v43 adds dispatch payload byte columns and stamps through v45', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT
      );
    `)
    for (let version = 1; version <= 43; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    expect(tableColumns(db, 'dispatches').has('dispatch_payload_bytes')).toBe(false)
    expect(tableColumns(db, 'dispatches').has('report_payload_bytes')).toBe(false)

    applySchemaVersion44(db)

    expect(tableColumns(db, 'dispatches').has('dispatch_payload_bytes')).toBe(true)
    expect(tableColumns(db, 'dispatches').has('report_payload_bytes')).toBe(true)
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = ?').get(44)
    ).toBeUndefined()
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = ?').get(45)
    ).toBeUndefined()

    initializeRuntimeDatabase(db)

    expect(tableColumns(db, 'dispatches').has('dispatch_payload_bytes')).toBe(true)
    expect(tableColumns(db, 'dispatches').has('report_payload_bytes')).toBe(true)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(45)).toEqual({
      version: 45,
    })
    expect(CURRENT_SCHEMA_VERSION).toBe(46)

    db.close()
  })

  test('v43→v44→v45 keeps an existing dispatch row and leaves new columns NULL', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        submitted_at INTEGER,
        reported_at INTEGER,
        report_text TEXT,
        artifacts TEXT,
        parent_dispatch_id TEXT,
        root_dispatch_id TEXT,
        seen_seq INTEGER NOT NULL DEFAULT 0
      );
    `)
    for (let version = 1; version <= 43; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }
    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status,
        created_at, delivered_at, report_text, artifacts, root_dispatch_id, seen_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'disp-keep',
      'ws-1',
      'ws-1:orchestrator',
      'worker-1',
      'implement login',
      'reported',
      1_000,
      1_100,
      'done',
      '[]',
      'disp-keep',
      3
    )

    expect(tableColumns(db, 'dispatches').has('dispatch_payload_bytes')).toBe(false)
    initializeRuntimeDatabase(db)

    const row = db
      .prepare(
        `SELECT id, text, status, created_at, delivered_at, report_text, root_dispatch_id, seen_seq,
                dispatch_payload_bytes, report_payload_bytes
         FROM dispatches WHERE id = ?`
      )
      .get('disp-keep') as {
      created_at: number
      delivered_at: number | null
      dispatch_payload_bytes: number | null
      id: string
      report_payload_bytes: number | null
      report_text: string | null
      root_dispatch_id: string
      seen_seq: number
      status: string
      text: string
    }
    expect(row).toEqual({
      created_at: 1_000,
      delivered_at: 1_100,
      dispatch_payload_bytes: null,
      id: 'disp-keep',
      report_payload_bytes: null,
      report_text: 'done',
      root_dispatch_id: 'disp-keep',
      seen_seq: 3,
      status: 'reported',
      text: 'implement login',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(45)).toEqual({
      version: 45,
    })
    db.close()
  })

  test('migration from v44 adds agent_launch_configs.cwd and stamps v45', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        command_preset_id TEXT,
        interactive_command TEXT,
        preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
        resume_args_template TEXT,
        session_id_capture_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)
    for (let version = 1; version <= 44; version += 1) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, 1)
    }

    expect(tableColumns(db, 'agent_launch_configs').has('cwd')).toBe(false)

    applySchemaVersion45(db)

    expect(tableColumns(db, 'agent_launch_configs').has('cwd')).toBe(true)
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = ?').get(45)
    ).toBeUndefined()

    initializeRuntimeDatabase(db)

    expect(tableColumns(db, 'agent_launch_configs').has('cwd')).toBe(true)
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(45)).toEqual({
      version: 45,
    })
    expect(CURRENT_SCHEMA_VERSION).toBe(46)

    db.close()
  })
})
