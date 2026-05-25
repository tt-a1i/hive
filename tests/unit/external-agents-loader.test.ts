import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'

import { loadExternalAgents } from '../../src/server/external-agents-loader.js'

let tempDirs: string[] = []

afterEach(() => {
  tempDirs = []
})

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ext-agents-'))
  tempDirs.push(dir)
  return dir
}

describe('loadExternalAgents', () => {
  test('extracts Name and Agent tags', () => {
    const dir = createTempDir()
    writeFileSync(
      join(dir, 'planner.md'),
      '<Name>颜真卿</Name>\n<Agent>claude</Agent>\n<Role>\n你是一个规划师\n</Role>'
    )
    const templates = loadExternalAgents(dir)
    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      id: 'external:planner',
      name: '颜真卿',
      suggestedName: '颜真卿',
      commandPresetId: 'claude',
      description: '你是一个规划师',
    })
  })

  test('falls back to slug name when Name tag is absent', () => {
    const dir = createTempDir()
    writeFileSync(join(dir, 'my-worker.md'), '<Role>Does stuff</Role>')
    const templates = loadExternalAgents(dir)
    expect(templates[0]).toMatchObject({
      name: 'My Worker',
      suggestedName: null,
      commandPresetId: null,
    })
  })

  test('handles empty Name/Agent tags as null', () => {
    const dir = createTempDir()
    writeFileSync(join(dir, 'test.md'), '<Name>  </Name>\n<Agent></Agent>\n<Role>hi</Role>')
    const templates = loadExternalAgents(dir)
    expect(templates[0]).toMatchObject({
      suggestedName: null,
      commandPresetId: null,
      name: 'Test',
    })
  })

  test('supports various Agent preset values', () => {
    const dir = createTempDir()
    writeFileSync(join(dir, 'a.md'), '<Agent>codex</Agent>\n<Role>x</Role>')
    writeFileSync(join(dir, 'b.md'), '<Agent>gemini</Agent>\n<Role>y</Role>')
    const templates = loadExternalAgents(dir)
    const presets = templates.map((t) => t.commandPresetId).sort()
    expect(presets).toEqual(['codex', 'gemini'])
  })

  test('returns empty array for non-existent directory', () => {
    expect(loadExternalAgents('/tmp/nonexistent-hive-dir-xyz')).toEqual([])
  })

  test('skips files without Role tag', () => {
    const dir = createTempDir()
    writeFileSync(join(dir, 'no-role.md'), '<Name>Bob</Name>\n<Agent>claude</Agent>')
    expect(loadExternalAgents(dir)).toEqual([])
  })
})
