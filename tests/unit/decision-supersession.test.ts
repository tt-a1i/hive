import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseMemoryAddArgs } from '../../src/cli/team.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'

test('decision replacement rolls back after insert failure and survives reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-decision-replace-'))
  const path = join(root, 'memory.sqlite')
  let db = new Database(path)
  try {
    initializeRuntimeDatabase(db)
    let store = createTeamMemoryStore(db)
    const base = {
      actor: { id: 'ws:orchestrator', name: 'Orchestrator', role: 'orchestrator' as const },
      workspaceId: 'ws',
      kind: 'decision' as const,
    }
    const original = store.addEntry({ ...base, body: 'Use SQLite.' })
    db.exec(
      "CREATE TRIGGER reject_new_memory BEFORE INSERT ON memory_entries BEGIN SELECT RAISE(ABORT, 'controlled failure'); END"
    )
    expect(() =>
      store.addEntry({ ...base, body: 'Use PostgreSQL.', supersedesId: original.id })
    ).toThrow()
    expect(store.getEntryWithSources('ws', original.id)).toEqual(original)
    expect(store.listEntries('ws', { statuses: ['active', 'archived'] })).toHaveLength(1)
    db.exec('DROP TRIGGER reject_new_memory')
    const replacement = store.addEntry({
      ...base,
      body: 'Use PostgreSQL.',
      supersedesId: original.id,
    })
    db.close()
    db = new Database(path)
    initializeRuntimeDatabase(db)
    store = createTeamMemoryStore(db)
    expect(store.getEntryWithSources('ws', original.id)).toMatchObject({
      body: 'Use SQLite.',
      status: 'archived',
    })
    expect(store.getEntryWithSources('ws', replacement.id)).toEqual(replacement)
    expect(store.searchEntries('ws', 'PostgreSQL').map((entry) => entry.id)).toEqual([
      replacement.id,
    ])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI preserves the exact decision ID and rejects a missing supersession argument', () => {
  expect(
    parseMemoryAddArgs(['Use PostgreSQL.', '--kind', 'decision', '--supersedes', 'old-id'])
  ).toMatchObject({ supersedesId: 'old-id', kind: 'decision' })
  expect(() => parseMemoryAddArgs(['Use PostgreSQL.', '--supersedes'])).toThrow()
})
