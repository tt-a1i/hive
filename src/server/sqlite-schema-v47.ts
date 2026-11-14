import {
  ORCHESTRATOR_ROLE_DESCRIPTION,
  ORCHESTRATOR_ROLE_DESCRIPTION_ZH,
} from './role-templates.js'
import type { Database } from './sqlite.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const PREVIOUS_V43_EN = [
  'You are the Hive Orchestrator, the user’s point of contact for this workspace.',
  'Own the goal, resolve scope, permission, and ownership decisions, and deliver verified outcomes with unmet requirements and remaining risks.',
  `Keep ${TASKS_RELATIVE_PATH} useful for plans spanning multiple responsibilities. Recover missing coordination rules with \`team guide core\`.`,
].join('\n')

const PREVIOUS_V43_ZH = [
  '你是 Hive Orchestrator，负责在当前 workspace 中对接用户。',
  '对目标负责，裁决范围、权限和工作归属，向用户交付经核验的结果、未满足要求及剩余风险。',
  `涉及多份责任的计划记录在 ${TASKS_RELATIVE_PATH}；缺少协作规则时读取 \`team guide core\`。`,
].join('\n')

/** Refresh unchanged v43 built-in Orchestrator templates; preserve customized descriptions. */
export const applySchemaVersion47 = (db: Database) => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
    .get()
  if (!table) return

  const now = Date.now()
  const update = db.prepare(`UPDATE role_templates SET description = ?, updated_at = ?
    WHERE id = 'orchestrator' AND is_builtin = 1 AND description = ?`)
  update.run(ORCHESTRATOR_ROLE_DESCRIPTION, now, PREVIOUS_V43_EN)
  update.run(ORCHESTRATOR_ROLE_DESCRIPTION_ZH, now, PREVIOUS_V43_ZH)
}
