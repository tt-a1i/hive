import type { Database } from 'better-sqlite3'

export const applySchemaVersion21 = (db: Database) => {
  db.exec(`
    CREATE TABLE discussion_messages_new (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      from_agent_id TEXT NOT NULL,
      message_type TEXT NOT NULL CHECK (message_type IN ('initial','discuss','conclude','system')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    INSERT INTO discussion_messages_new (sequence, group_id, round, from_agent_id, message_type, text, created_at)
      SELECT sequence, group_id, round, from_agent_id, message_type, text, created_at FROM discussion_messages;

    DROP TABLE discussion_messages;

    ALTER TABLE discussion_messages_new RENAME TO discussion_messages;

    CREATE INDEX IF NOT EXISTS idx_discussion_messages_group_round
      ON discussion_messages (group_id, round, sequence);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_discussion_messages_one_per_round
      ON discussion_messages (group_id, round, from_agent_id)
      WHERE message_type = 'discuss';
  `)
}
