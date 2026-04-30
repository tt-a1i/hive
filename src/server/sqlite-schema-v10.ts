import type { Database } from 'better-sqlite3'

import { BUILTIN_COMMAND_PRESETS } from './command-preset-defaults.js'

export const applySchemaVersion10 = (db: Database) => {
  const updatePreset = db.prepare(
    `UPDATE command_presets
     SET resume_args_template = ?,
         session_id_capture = ?,
         yolo_args_template = ?,
         updated_at = ?
     WHERE id = ? AND is_builtin = 1`
  )
  const now = Date.now()
  for (const preset of BUILTIN_COMMAND_PRESETS) {
    updatePreset.run(
      preset.resumeArgsTemplate,
      preset.sessionIdCapture ? JSON.stringify(preset.sessionIdCapture) : null,
      preset.yoloArgsTemplate ? JSON.stringify(preset.yoloArgsTemplate) : null,
      now,
      preset.id
    )
  }
}
