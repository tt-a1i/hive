import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { RoleTemplateRecord } from './role-template-store.js'

export interface ExternalRoleTemplate extends RoleTemplateRecord {
  source: 'external'
  readonly: true
  suggestedName: string | null
  commandPresetId: string | null
}

const extractRole = (content: string): string => {
  const match = content.match(/<Role>([\s\S]*?)<\/Role>/)
  if (!match?.[1]) return ''
  return match[1].trim()
}

const extractTag = (content: string, tag: string): string | null => {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  if (!match?.[1]) return null
  const value = match[1].trim()
  return value || null
}

const slugToName = (slug: string): string =>
  slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

export const loadExternalAgents = (dirPath: string): ExternalRoleTemplate[] => {
  const resolved = resolve(dirPath)
  let entries: string[]
  try {
    entries = readdirSync(resolved)
  } catch {
    return []
  }

  const templates: ExternalRoleTemplate[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const slug = basename(entry, '.md')
    let content: string
    try {
      content = readFileSync(join(resolved, entry), 'utf-8')
    } catch {
      continue
    }
    const description = extractRole(content)
    if (!description) continue

    const suggestedName = extractTag(content, 'Name')
    const commandPresetId = extractTag(content, 'Agent')

    templates.push({
      id: `external:${slug}`,
      name: suggestedName ?? slugToName(slug),
      roleType: 'custom',
      description,
      defaultCommand: '',
      defaultArgs: [],
      defaultEnv: {},
      isBuiltin: false,
      discussionTriggers: null,
      useCount: 0,
      source: 'external',
      readonly: true,
      suggestedName,
      commandPresetId,
    })
  }
  return templates
}
