import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

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
}

export interface RoleTemplateInput {
  name: string
  roleType: RoleTemplateType
  description: string
  defaultCommand: string
  defaultArgs: string[]
  defaultEnv: Record<string, string>
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

const toRecord = (row: {
  id: string
  name: string
  role_type: RoleTemplateType
  description: string
  default_command: string
  default_args: string
  default_env: string
  is_builtin: number
}): RoleTemplateRecord => ({
  id: row.id,
  name: row.name,
  roleType: row.role_type,
  description: row.description,
  defaultCommand: row.default_command,
  defaultArgs: parseStringArray(row.default_args),
  defaultEnv: parseEnv(row.default_env),
  isBuiltin: row.is_builtin === 1,
})

export const createRoleTemplateStore = (db: Database) => {
  const list = () => {
    return db
      .prepare(
        `SELECT id, name, role_type, description, default_command, default_args, default_env, is_builtin
         FROM role_templates ORDER BY is_builtin DESC, created_at ASC`
      )
      .all()
      .map((row) => toRecord(row as Parameters<typeof toRecord>[0]))
  }

  const create = (input: RoleTemplateInput) => {
    const record = { id: randomUUID(), ...input, isBuiltin: false }
    const now = Date.now()
    db.prepare(
      `INSERT INTO role_templates (
         id, name, role_type, description, default_command, default_args, default_env,
         is_builtin, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      record.id,
      record.name,
      record.roleType,
      record.description,
      record.defaultCommand,
      serializeArgs(record.defaultArgs),
      serializeEnv(record.defaultEnv),
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
       SET name = ?, role_type = ?, description = ?, default_command = ?, default_args = ?, default_env = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.name,
      input.roleType,
      input.description,
      input.defaultCommand,
      serializeArgs(input.defaultArgs),
      serializeEnv(input.defaultEnv),
      Date.now(),
      id
    )
    return { ...current, ...input }
  }

  const remove = (id: string) => {
    const current = list().find((template) => template.id === id)
    if (!current) throw new Error(`Role template not found: ${id}`)
    if (current.isBuiltin) throw new ConflictError(`Builtin role template is read-only: ${id}`)
    db.prepare('DELETE FROM role_templates WHERE id = ?').run(id)
  }

  return { create, list, remove, update }
}
