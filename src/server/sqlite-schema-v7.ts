import type { Database } from 'better-sqlite3'

import {
  CODER_ROLE_DESCRIPTION,
  ORCHESTRATOR_ROLE_DESCRIPTION,
  REVIEWER_ROLE_DESCRIPTION,
  TESTER_ROLE_DESCRIPTION,
} from './role-templates.js'

export const applySchemaVersion7 = (db: Database) => {
  const now = Date.now()

  db.exec(`
    CREATE TABLE IF NOT EXISTS command_presets (
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

    CREATE TABLE IF NOT EXISTS role_templates (
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

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
  `)

  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    'claude',
    'Claude Code (CC)',
    'claude',
    '[]',
    '{}',
    '--resume {session_id}',
    JSON.stringify({
      source: 'claude_project_jsonl_dir',
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
    }),
    JSON.stringify(['--dangerously-skip-permissions']),
    now,
    now
  )
  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('codex', 'Codex', 'codex', '[]', '{}', null, null, null, now, now)
  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('opencode', 'OpenCode', 'opencode', '[]', '{}', null, null, null, now, now)
  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('gemini', 'Gemini', 'gemini', '[]', '{}', null, null, null, now, now)

  db.prepare(
    `INSERT INTO role_templates (
       id, name, role_type, description, default_command, default_args, default_env,
       is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    'orchestrator',
    'Orchestrator',
    'orchestrator',
    ORCHESTRATOR_ROLE_DESCRIPTION,
    'claude',
    '[]',
    '{}',
    now,
    now
  )
  db.prepare(
    `INSERT INTO role_templates (
       id, name, role_type, description, default_command, default_args, default_env,
       is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('coder', 'Coder', 'coder', CODER_ROLE_DESCRIPTION, 'claude', '[]', '{}', now, now)
  db.prepare(
    `INSERT INTO role_templates (
       id, name, role_type, description, default_command, default_args, default_env,
       is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    'reviewer',
    'Reviewer',
    'reviewer',
    REVIEWER_ROLE_DESCRIPTION,
    'claude',
    '[]',
    '{}',
    now,
    now
  )
  db.prepare(
    `INSERT INTO role_templates (
       id, name, role_type, description, default_command, default_args, default_env,
       is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('tester', 'Tester', 'tester', TESTER_ROLE_DESCRIPTION, 'claude', '[]', '{}', now, now)

  db.prepare(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`
  ).run('active_workspace_id', null, now)
}
