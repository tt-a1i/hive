import type { Database } from 'better-sqlite3'

import { CLAUDE_DEFAULT_YOLO_ARGS } from './claude-command-defaults.js'

export const applySchemaVersion9 = (db: Database) => {
  db.prepare(
    `UPDATE command_presets
     SET yolo_args_template = ?, updated_at = ?
     WHERE id = ? AND is_builtin = 1`
  ).run(JSON.stringify(CLAUDE_DEFAULT_YOLO_ARGS), Date.now(), 'claude')
}
