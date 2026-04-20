import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('schema version', () => {
  test('runtime sqlite initializes a schema_version table', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-version-'))
    tempDirs.push(dataDir)

    createRuntimeStore({ dataDir })

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get() as { name: string } | undefined

    expect(row).toEqual({ name: 'schema_version' })
    db.close()
  })

  test('latest schema includes last_session_id, pid, ended_at and drops messages.kind', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-columns-'))
    tempDirs.push(dataDir)

    createRuntimeStore({ dataDir })

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
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

    expect(workerColumns.has('last_session_id')).toBe(true)
    expect(agentRunColumns.has('pid')).toBe(true)
    expect(agentRunColumns.has('ended_at')).toBe(true)
    expect(launchConfigColumns.has('resume_args_template')).toBe(true)
    expect(launchConfigColumns.has('session_id_capture_json')).toBe(true)
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

    const presetCount = db
      .prepare('SELECT COUNT(*) AS count FROM command_presets WHERE is_builtin = 1')
      .get() as { count: number }
    const roleTemplateCount = db
      .prepare('SELECT COUNT(*) AS count FROM role_templates WHERE is_builtin = 1')
      .get() as { count: number }
    const appState = db
      .prepare('SELECT key, value FROM app_state WHERE key = ?')
      .get('active_workspace_id') as { key: string; value: string | null } | undefined

    expect(presetCount.count).toBe(4)
    expect(roleTemplateCount.count).toBe(4)
    expect(appState).toEqual({ key: 'active_workspace_id', value: null })

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
})
