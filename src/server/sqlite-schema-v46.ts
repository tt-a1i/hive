import type { Database } from './sqlite.js'

/** Retire external controllers and team memory while preserving workspace history. */
export const applySchemaVersion46 = (db: Database) => {
  db.exec(`
    DROP TRIGGER IF EXISTS controller_dispatch_terminal;
    DROP TRIGGER IF EXISTS controller_member_exit;
    DROP TRIGGER IF EXISTS memory_fts_ai;
    DROP TRIGGER IF EXISTS memory_fts_ad;
    DROP TRIGGER IF EXISTS memory_fts_au;
    DROP TABLE IF EXISTS controller_notifications;
    DROP TABLE IF EXISTS controller_operations;
    DROP TABLE IF EXISTS controller_connect_requests;
    DROP TABLE IF EXISTS workspace_controllers;
    DROP TABLE IF EXISTS external_goal_events;
    DROP TABLE IF EXISTS external_goal_sessions;
    DROP TABLE IF EXISTS dream_runs;
    DROP TABLE IF EXISTS memory_injections;
    DROP TABLE IF EXISTS memory_sources;
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS memory_fts_trigram;
    DROP TABLE IF EXISTS memory_entries;
  `)
  const columns = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'controller_mode')) {
    db.exec(
      "UPDATE workspaces SET controller_mode = 'internal' WHERE controller_mode != 'internal'"
    )
  }
  db.exec(`
    INSERT INTO workers (id, workspace_id, name, description, role, created_at)
    SELECT id || ':orchestrator', id, 'Orchestrator', NULL, 'orchestrator', created_at
    FROM workspaces
    WHERE NOT EXISTS (SELECT 1 FROM workers WHERE workers.id = workspaces.id || ':orchestrator');
  `)
}
