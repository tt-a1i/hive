import type { Database } from './sqlite.js'

/** Durable mailbox receipts, delegation ownership, and explicit report outcome. */
export const applySchemaVersion46 = (db: Database) => {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN outcome TEXT CHECK(outcome IN ('success', 'failed'));
    ALTER TABLE dispatches ADD COLUMN delegated_from_id TEXT;
    CREATE INDEX idx_dispatches_delegated_from ON dispatches(delegated_from_id);
    CREATE TABLE mailbox_batches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE UNIQUE INDEX idx_mailbox_pending ON mailbox_batches(workspace_id, agent_id)
      WHERE acknowledged_at IS NULL;
    CREATE TABLE mailbox_receipts (
      message_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL
    );
  `)
}
