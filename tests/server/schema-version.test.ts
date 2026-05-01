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
    expect(launchConfigColumns.has('command_preset_id')).toBe(true)
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
    expect(opencode.resume_args_template).toBe('--session {session_id}')
    expect(JSON.parse(opencode.session_id_capture ?? '{}')).toMatchObject({
      source: 'opencode_session_db',
    })
    expect(JSON.parse(opencode.yolo_args_template ?? '[]')).toEqual([
      '--dangerously-skip-permissions',
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(10)).toEqual({
      version: 10,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(11)).toEqual({
      version: 11,
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
    expect(byId.opencode).toEqual(['--dangerously-skip-permissions'])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(11)).toEqual({
      version: 11,
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

    expect(byId.coder).toContain('实现型 Coder')
    expect(byId.coder).toContain('交付说明要包含')
    expect(byId.reviewer).toContain('监工型 Reviewer')
    expect(byId.reviewer).toContain('blocking 问题')
    expect(byId.tester).toContain('验证型 Tester')
    expect(byId.orchestrator).toContain('组织右侧真实成员协作')
    expect(byId.orchestrator).toContain('.hive/tasks.md')
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(12)).toEqual({
      version: 12,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(13)).toEqual({
      version: 13,
    })

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
