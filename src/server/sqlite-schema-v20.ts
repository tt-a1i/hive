import type { Database } from 'better-sqlite3'

export const applySchemaVersion20 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discussion_groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      max_rounds INTEGER NOT NULL DEFAULT 3,
      current_round INTEGER NOT NULL DEFAULT 0,
      max_messages INTEGER NOT NULL DEFAULT 20,
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('thinking','discussing','concluding','concluded','cancelled')),
      listen_mode TEXT NOT NULL DEFAULT 'db',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      concluded_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_groups_workspace
      ON discussion_groups (workspace_id, status);

    CREATE TABLE IF NOT EXISTS discussion_members (
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      member_status TEXT NOT NULL DEFAULT 'invited'
        CHECK (member_status IN ('invited','initial_submitted','active','round_submitted','skipped','final_submitted','failed')),
      initial_position TEXT,
      final_position TEXT,
      rounds_participated INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER,
      PRIMARY KEY (group_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS discussion_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      from_agent_id TEXT NOT NULL,
      message_type TEXT NOT NULL CHECK (message_type IN ('initial','discuss','conclude')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_messages_group_round
      ON discussion_messages (group_id, round, sequence);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_discussion_messages_one_per_round
      ON discussion_messages (group_id, round, from_agent_id)
      WHERE message_type = 'discuss';

    CREATE INDEX IF NOT EXISTS idx_discussion_members_active_agent
      ON discussion_members (agent_id, group_id);
  `)
}
