import type { Database } from './sqlite.js'

import { applySchemaVersion5 } from './sqlite-schema-v5.js'
import { applySchemaVersion7 } from './sqlite-schema-v7.js'
import { applySchemaVersion8 } from './sqlite-schema-v8.js'
import { applySchemaVersion9 } from './sqlite-schema-v9.js'
import { applySchemaVersion10 } from './sqlite-schema-v10.js'
import { applySchemaVersion11 } from './sqlite-schema-v11.js'
import { applySchemaVersion12 } from './sqlite-schema-v12.js'
import { applySchemaVersion13 } from './sqlite-schema-v13.js'
import { applySchemaVersion14 } from './sqlite-schema-v14.js'
import { applySchemaVersion15 } from './sqlite-schema-v15.js'
import { applySchemaVersion16 } from './sqlite-schema-v16.js'
import { applySchemaVersion17 } from './sqlite-schema-v17.js'
import { applySchemaVersion18 } from './sqlite-schema-v18.js'
import { applySchemaVersion19 } from './sqlite-schema-v19.js'
import { applySchemaVersion20 } from './sqlite-schema-v20.js'
import { applySchemaVersion21 } from './sqlite-schema-v21.js'
import { applySchemaVersion22 } from './sqlite-schema-v22.js'
import { applySchemaVersion23 } from './sqlite-schema-v23.js'
import { applySchemaVersion24 } from './sqlite-schema-v24.js'
import { applySchemaVersion25 } from './sqlite-schema-v25.js'
import { applySchemaVersion26 } from './sqlite-schema-v26.js'
import { applySchemaVersion27 } from './sqlite-schema-v27.js'
import { applySchemaVersion28 } from './sqlite-schema-v28.js'
import { applySchemaVersion29 } from './sqlite-schema-v29.js'
import { applySchemaVersion30 } from './sqlite-schema-v30.js'
import { applySchemaVersion31 } from './sqlite-schema-v31.js'
import { applySchemaVersion32 } from './sqlite-schema-v32.js'
import { applySchemaVersion33 } from './sqlite-schema-v33.js'
import { applySchemaVersion34 } from './sqlite-schema-v34.js'
import { applySchemaVersion35 } from './sqlite-schema-v35.js'
import { applySchemaVersion36 } from './sqlite-schema-v36.js'
import { applySchemaVersion37 } from './sqlite-schema-v37.js'
import { applySchemaVersion38 } from './sqlite-schema-v38.js'
import { applySchemaVersion39 } from './sqlite-schema-v39.js'
import { applySchemaVersion40 } from './sqlite-schema-v40.js'
import { applySchemaVersion41 } from './sqlite-schema-v41.js'
import { applySchemaVersion42 } from './sqlite-schema-v42.js'
import { applySchemaVersion43 } from './sqlite-schema-v43.js'
import { applySchemaVersion44 } from './sqlite-schema-v44.js'
import { applySchemaVersion45 } from './sqlite-schema-v45.js'
import { applySchemaVersion46 } from './sqlite-schema-v46.js'

export const CURRENT_SCHEMA_VERSION = 46

// Idempotent column-add helper. SQLite doesn't have `ALTER TABLE … ADD COLUMN
// IF NOT EXISTS`, so PRAGMA-check first. Safe to call on every init; required
// for foreign-built DBs where the version-gated migration is skipped.
const ensureColumn = (db: Database, table: string, column: string, definition: string): void => {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  )
  if (!present.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export const initializeRuntimeDatabase = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      avatar TEXT,
      last_session_id TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
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

    CREATE TABLE IF NOT EXISTS agent_launch_configs (
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

    CREATE TABLE IF NOT EXISTS agent_runs (
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

    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      last_session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS dispatches (
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

    CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_created_at
      ON dispatches (workspace_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatches_open_by_worker
      ON dispatches (workspace_id, to_agent_id, status, sequence);

    CREATE TABLE IF NOT EXISTS report_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_report_outbox_pending
      ON report_outbox (workspace_id, target_agent_id, delivered_at, created_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      script_path TEXT NOT NULL,
      script_hash TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      args TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace
      ON workflow_runs (workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      script_path TEXT NOT NULL,
      cron TEXT NOT NULL,
      args TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due
      ON workflow_schedules (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_schedules_workspace
      ON workflow_schedules (workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS workspace_uploads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      remote_device_id TEXT,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_uploads_workspace_created
      ON workspace_uploads (workspace_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS external_goal_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      goal TEXT NOT NULL,
      context_json TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_external_goal_sessions_workspace
      ON external_goal_sessions (workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS external_goal_events (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      body TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(goal_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_external_goal_events_goal
      ON external_goal_events (goal_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_external_goal_events_workspace
      ON external_goal_events (workspace_id, created_at);
  `)

  // Idempotent column additions — run on every init regardless of
  // schema_version. The v19 migration adds these columns but is gated on
  // !appliedVersions.has(19); a foreign-built DB whose v19 was a DIFFERENT
  // migration leaves these absent. PRAGMA + ALTER here makes the writes safe.
  ensureColumn(db, 'workers', 'ephemeral', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'workers', 'spawned_by', 'TEXT')
  ensureColumn(db, 'workers', 'avatar', 'TEXT')
  ensureColumn(db, 'dispatches', 'workflow_run_id', 'TEXT')
  ensureColumn(db, 'dispatches', 'step_index', 'INTEGER')
  // M9 — phase + label on dispatches so the workflow UI can render the
  // phase tree + agent fleet view (mirrors Claude Code's /workflows view).
  ensureColumn(db, 'dispatches', 'phase', 'TEXT')
  ensureColumn(db, 'dispatches', 'label', 'TEXT')
  // Issue #75 — per-dispatch PTY envelope sizes. Idempotent for foreign-built DBs.
  ensureColumn(db, 'dispatches', 'dispatch_payload_bytes', 'INTEGER')
  ensureColumn(db, 'dispatches', 'report_payload_bytes', 'INTEGER')
  ensureColumn(db, 'agent_launch_configs', 'cwd', 'TEXT')
  // M10: capture the workflow script's `return` value so the UI can render
  // a single canonical "Result" panel and the orchestrator notification can
  // include it.
  ensureColumn(db, 'workflow_runs', 'result', 'TEXT')
  // TIER 2 #5: parent_run_id lets the Drawer render nested workflow() calls
  // as a tree (child runs indented under their parent). Without it,
  // nested runs were flat and the user couldn't tell which child
  // belonged to which parent. Null on top-level runs.
  ensureColumn(db, 'workflow_runs', 'parent_run_id', 'TEXT')
  // TIER 2 #3: log() narrator pipeline. Authors call `log('Discovered 47
  // endpoints')` from a workflow script; rows live here and stream to
  // the Drawer's narrator lane + the last few lines are appended to
  // the orchestrator's completion notification.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_run
      ON workflow_run_logs (run_id, id);
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dispatches_workflow ON dispatches (workflow_run_id, step_index)'
  )
  const versions = db
    .prepare('SELECT version FROM schema_version ORDER BY version ASC')
    .all() as Array<{ version: number }>
  const appliedVersions = new Set(versions.map((row) => row.version))

  if (!appliedVersions.has(1)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, Date.now())
    appliedVersions.add(1)
  }

  if (!appliedVersions.has(2)) {
    const workerColumns = new Set(
      (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

    if (workerColumns.size > 0 && !workerColumns.has('description')) {
      db.exec('ALTER TABLE workers ADD COLUMN description TEXT')
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, Date.now())
  }

  if (!appliedVersions.has(3)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, Date.now())
    appliedVersions.add(3)
  }

  if (!appliedVersions.has(4)) {
    const messageColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

    if (messageColumns.size > 0 && !messageColumns.has('artifacts')) {
      db.exec('ALTER TABLE messages ADD COLUMN artifacts TEXT')
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(4, Date.now())
  }

  if (!appliedVersions.has(5)) {
    applySchemaVersion5(db)

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(5, Date.now())
  }

  if (!appliedVersions.has(6)) {
    const launchConfigColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    if (!launchConfigColumns.has('resume_args_template')) {
      db.exec('ALTER TABLE agent_launch_configs ADD COLUMN resume_args_template TEXT')
    }
    if (!launchConfigColumns.has('session_id_capture_json')) {
      db.exec('ALTER TABLE agent_launch_configs ADD COLUMN session_id_capture_json TEXT')
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        last_session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(6, Date.now())
  }

  if (!appliedVersions.has(7)) {
    applySchemaVersion7(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(7, Date.now())
  }

  if (!appliedVersions.has(8)) {
    applySchemaVersion8(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(8, Date.now())
  }

  if (!appliedVersions.has(9)) {
    applySchemaVersion9(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(9, Date.now())
  }

  if (!appliedVersions.has(10)) {
    applySchemaVersion10(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(10, Date.now())
  }

  if (!appliedVersions.has(11)) {
    applySchemaVersion11(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(11, Date.now())
  }

  if (!appliedVersions.has(12)) {
    applySchemaVersion12(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(12, Date.now())
  }

  if (!appliedVersions.has(13)) {
    applySchemaVersion13(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(13, Date.now())
  }

  if (!appliedVersions.has(14)) {
    applySchemaVersion14(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(14, Date.now())
  }

  applySchemaVersion15(db)
  if (!appliedVersions.has(15)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(15, Date.now())
  }

  if (!appliedVersions.has(16)) {
    applySchemaVersion16(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(16, Date.now())
  }

  if (!appliedVersions.has(17)) {
    applySchemaVersion17(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(17, Date.now())
  }

  if (!appliedVersions.has(18)) {
    applySchemaVersion18(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(18, Date.now())
  }

  if (!appliedVersions.has(19)) {
    applySchemaVersion19(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(19, Date.now())
  }

  if (!appliedVersions.has(20)) {
    applySchemaVersion20(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(20, Date.now())
  }

  if (!appliedVersions.has(21)) {
    applySchemaVersion21(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(21, Date.now())
  }

  if (!appliedVersions.has(22)) {
    applySchemaVersion22(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(22, Date.now())
  }

  if (!appliedVersions.has(23)) {
    applySchemaVersion23(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(23, Date.now())
  }

  if (!appliedVersions.has(24)) {
    applySchemaVersion24(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(24, Date.now())
  }

  applySchemaVersion25(db)
  if (!appliedVersions.has(25)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(25, Date.now())
  }

  applySchemaVersion26(db)
  if (!appliedVersions.has(26)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(26, Date.now())
  }

  if (!appliedVersions.has(27)) {
    applySchemaVersion27(db, { rebuild: true })
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(27, Date.now())
  } else {
    applySchemaVersion27(db, { rebuild: false })
  }

  applySchemaVersion28(db)
  if (!appliedVersions.has(28)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(28, Date.now())
  }

  applySchemaVersion29(db)
  if (!appliedVersions.has(29)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(29, Date.now())
  }

  applySchemaVersion30(db)
  if (!appliedVersions.has(30)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(30, Date.now())
  }

  applySchemaVersion31(db)
  if (!appliedVersions.has(31)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(31, Date.now())
  }

  applySchemaVersion32(db)
  if (!appliedVersions.has(32)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(32, Date.now())
  }

  applySchemaVersion33(db)
  if (!appliedVersions.has(33)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(33, Date.now())
  }

  applySchemaVersion34(db)
  if (!appliedVersions.has(34)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(34, Date.now())
  }

  if (!appliedVersions.has(35)) {
    applySchemaVersion35(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(35, Date.now())
  }

  applySchemaVersion36(db)
  if (!appliedVersions.has(36)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(36, Date.now())
  }

  applySchemaVersion37(db)
  if (!appliedVersions.has(37)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(37, Date.now())
  }

  applySchemaVersion38(db)
  if (!appliedVersions.has(38)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(38, Date.now())
  }

  applySchemaVersion39(db)
  if (!appliedVersions.has(39)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(39, Date.now())
  }

  applySchemaVersion40(db)
  if (!appliedVersions.has(40)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(40, Date.now())
  }
  db.transaction(() => {
    applySchemaVersion41(db)
    if (!appliedVersions.has(41))
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        41,
        Date.now()
      )
  })()
  for (const [version, apply] of [
    [42, applySchemaVersion42],
    [43, applySchemaVersion43],
    [44, applySchemaVersion44],
    [45, applySchemaVersion45],
    [46, applySchemaVersion46],
  ] as const) {
    if (!appliedVersions.has(version)) {
      db.transaction(() => {
        apply(db)
        db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
          version,
          Date.now()
        )
      })()
    }
  }
}
