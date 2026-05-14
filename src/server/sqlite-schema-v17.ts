import type { Database } from 'better-sqlite3'

import { BUILTIN_COMMAND_PRESETS } from './command-preset-defaults.js'

export const applySchemaVersion17 = (db: Database) => {
  const commandPresetsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
    .get()
  if (!commandPresetsTable) return

  const updatePreset = db.prepare(
    `UPDATE command_presets
     SET yolo_args_template = ?, updated_at = ?
     WHERE id = ? AND is_builtin = 1`
  )
  const now = Date.now()
  for (const preset of BUILTIN_COMMAND_PRESETS) {
    updatePreset.run(
      preset.yoloArgsTemplate?.length ? JSON.stringify(preset.yoloArgsTemplate) : null,
      now,
      preset.id
    )
  }
}
