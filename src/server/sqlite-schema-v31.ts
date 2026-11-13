import { getBuiltinCommandPreset } from './command-preset-defaults.js'
import type { Database } from './sqlite.js'

const upsertBuiltinCommandPreset = (db: Database, id: string, now: number) => {
  const preset = getBuiltinCommandPreset(id)
  if (!preset) return

  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       command = excluded.command,
       args = excluded.args,
       env = excluded.env,
       resume_args_template = excluded.resume_args_template,
       session_id_capture = excluded.session_id_capture,
       yolo_args_template = excluded.yolo_args_template,
       updated_at = excluded.updated_at
    WHERE command_presets.is_builtin = 1`
  ).run(
    preset.id,
    preset.displayName,
    preset.command,
    '[]',
    '{}',
    preset.resumeArgsTemplate,
    preset.sessionIdCapture ? JSON.stringify(preset.sessionIdCapture) : null,
    preset.yoloArgsTemplate ? JSON.stringify(preset.yoloArgsTemplate) : null,
    now,
    now
  )
}

export const applySchemaVersion31 = (db: Database) => {
  const hasCommandPresets = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
    .get()
  if (!hasCommandPresets) return

  const now = Date.now()
  upsertBuiltinCommandPreset(db, 'cursor', now)
  upsertBuiltinCommandPreset(db, 'grok', now)
  upsertBuiltinCommandPreset(db, 'kimi', now)
}
