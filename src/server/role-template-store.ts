import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type { DiscussionTriggers } from './discussion-templates.js'
import { ConflictError } from './http-errors.js'

export type RoleTemplateType = 'orchestrator' | 'coder' | 'reviewer' | 'tester' | 'custom'

export interface RoleTemplateRecord {
  id: string
  name: string
  roleType: RoleTemplateType
  description: string
  defaultCommand: string
  defaultArgs: string[]
  defaultEnv: Record<string, string>
  isBuiltin: boolean
  discussionTriggers: DiscussionTriggers | null
  suggestedName: string | null
  commandPresetId: string | null
  useCount: number
}

export interface RoleTemplateInput {
  name: string
  roleType: RoleTemplateType
  description: string
  defaultCommand: string
  defaultArgs: string[]
  defaultEnv: Record<string, string>
  discussionTriggers?: DiscussionTriggers | null
  suggestedName?: string | null
  commandPresetId?: string | null
}

const parseStringArray = (value: string | null) => {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
}

const parseEnv = (value: string | null) => {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}
}

const serializeArgs = (args: string[]) => JSON.stringify(args)
const serializeEnv = (env: Record<string, string>) => JSON.stringify(env)

const parseDiscussionTriggers = (value: string | null): DiscussionTriggers | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as DiscussionTriggers
    if (parsed && Array.isArray(parsed.rules)) return parsed
    return null
  } catch {
    return null
  }
}

const toRecord = (row: {
  id: string
  name: string
  role_type: RoleTemplateType
  description: string
  default_command: string
  default_args: string
  default_env: string
  is_builtin: number
  discussion_triggers?: string | null
  suggested_name?: string | null
  command_preset_id?: string | null
  use_count?: number
}): RoleTemplateRecord => ({
  id: row.id,
  name: row.name,
  roleType: row.role_type,
  description: row.description,
  defaultCommand: row.default_command,
  defaultArgs: parseStringArray(row.default_args),
  defaultEnv: parseEnv(row.default_env),
  isBuiltin: row.is_builtin === 1,
  discussionTriggers: parseDiscussionTriggers(row.discussion_triggers ?? null),
  suggestedName: row.suggested_name ?? null,
  commandPresetId: row.command_preset_id ?? null,
  useCount: row.use_count ?? 0,
})

export const createRoleTemplateStore = (db: Database) => {
  const list = () => {
    return db
      .prepare(
        `SELECT id, name, role_type, description, default_command, default_args, default_env, is_builtin, discussion_triggers, suggested_name, command_preset_id, use_count
         FROM role_templates ORDER BY is_builtin DESC, created_at ASC`
      )
      .all()
      .map((row) => toRecord(row as Parameters<typeof toRecord>[0]))
  }

  const create = (input: RoleTemplateInput) => {
    const record: RoleTemplateRecord = {
      id: randomUUID(),
      ...input,
      isBuiltin: false,
      discussionTriggers: input.discussionTriggers ?? null,
      suggestedName: input.suggestedName ?? null,
      commandPresetId: input.commandPresetId ?? null,
      useCount: 0,
    }
    const now = Date.now()
    db.prepare(
      `INSERT INTO role_templates (
         id, name, role_type, description, default_command, default_args, default_env,
         is_builtin, discussion_triggers, suggested_name, command_preset_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.name,
      record.roleType,
      record.description,
      record.defaultCommand,
      serializeArgs(record.defaultArgs),
      serializeEnv(record.defaultEnv),
      record.discussionTriggers ? JSON.stringify(record.discussionTriggers) : null,
      record.suggestedName,
      record.commandPresetId,
      now,
      now
    )
    return record
  }

  const update = (id: string, input: RoleTemplateInput) => {
    const current = list().find((template) => template.id === id)
    if (!current) throw new Error(`Role template not found: ${id}`)
    if (current.isBuiltin) throw new ConflictError(`Builtin role template is read-only: ${id}`)
    db.prepare(
      `UPDATE role_templates
       SET name = ?, role_type = ?, description = ?, default_command = ?, default_args = ?, default_env = ?, discussion_triggers = ?, suggested_name = ?, command_preset_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.name,
      input.roleType,
      input.description,
      input.defaultCommand,
      serializeArgs(input.defaultArgs),
      serializeEnv(input.defaultEnv),
      input.discussionTriggers ? JSON.stringify(input.discussionTriggers) : null,
      input.suggestedName ?? null,
      input.commandPresetId ?? null,
      Date.now(),
      id
    )
    return {
      ...current,
      ...input,
      discussionTriggers: input.discussionTriggers ?? null,
      suggestedName: input.suggestedName ?? null,
      commandPresetId: input.commandPresetId ?? null,
    }
  }

  const remove = (id: string) => {
    const current = list().find((template) => template.id === id)
    if (!current) throw new Error(`Role template not found: ${id}`)
    if (current.isBuiltin) throw new ConflictError(`Builtin role template is read-only: ${id}`)
    db.prepare('DELETE FROM role_templates WHERE id = ?').run(id)
  }

  const incrementUseCount = (name: string) => {
    db.prepare('UPDATE role_templates SET use_count = use_count + 1 WHERE name = ?').run(name)
  }

  return { create, incrementUseCount, list, remove, update }
}
