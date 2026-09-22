import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  createTeamMemoryStore,
  MemoryEntryNotFoundError,
  MemoryEntryStatusError,
} from '../../src/server/team-memory-store.js'

describe('team memory store', () => {
  test('orchestrator writes active memory with actor snapshots, worker writes candidate memory', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)

    const active = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Use the relay path for remote mobile API calls.',
      kind: 'decision',
      tags: ['remote', 'relay'],
      workspaceId: 'ws-1',
    })
    const candidate = store.addEntry({
      actor: { id: 'worker-1', name: 'Alice', role: 'coder' },
      body: 'The setup script fails if pnpm is missing.',
      kind: 'pitfall',
      tags: ['setup'],
      workspaceId: 'ws-1',
    })

    expect(active).toMatchObject({
      body: 'Use the relay path for remote mobile API calls.',
      confidence: 1,
      kind: 'decision',
      source: 'manual',
      status: 'active',
      tags: ['remote', 'relay'],
      workspaceId: 'ws-1',
    })
    expect(active.sources).toEqual([
      expect.objectContaining({
        actorAgentIdSnapshot: 'ws-1:orchestrator',
        actorNameSnapshot: 'Queen',
        actorRoleSnapshot: 'orchestrator',
        excerpt: 'Use the relay path for remote mobile API calls.',
        sourceType: 'manual',
        textHash: expect.any(String),
      }),
    ])
    expect(candidate).toMatchObject({
      body: 'The setup script fails if pnpm is missing.',
      kind: 'pitfall',
      status: 'candidate',
      workspaceId: 'ws-1',
    })
    expect(candidate.sources[0]).toMatchObject({
      actorAgentIdSnapshot: 'worker-1',
      actorNameSnapshot: 'Alice',
      actorRoleSnapshot: 'coder',
    })

    const fetched = store.getEntryWithSources('ws-1', active.id)
    expect(fetched).toEqual(active)
    expect(store.getEntryWithSources('ws-2', active.id)).toBeUndefined()

    db.close()
  })

  test('logInjections audits injected memories and updates last_injected_at', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const memory = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Pinned startup memory should be auditable.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })

    const ids = store.logInjections({
      contextType: 'startup',
      memoryIds: [memory.id],
      targetAgentIdSnapshot: 'worker-1',
      workspaceId: 'ws-1',
    })

    expect(ids).toHaveLength(1)
    const injectionId = ids[0]
    if (!injectionId) throw new Error('Expected a recorded memory injection')
    const row = db.prepare('SELECT * FROM memory_injections WHERE id = ?').get(injectionId) as
      | {
          context_type: string
          memory_id: string
          target_agent_id_snapshot: string
          workspace_id: string
        }
      | undefined
    expect(row).toEqual(
      expect.objectContaining({
        context_type: 'startup',
        memory_id: memory.id,
        target_agent_id_snapshot: 'worker-1',
        workspace_id: 'ws-1',
      })
    )
    expect(store.getEntryWithSources('ws-1', memory.id)?.lastInjectedAt).toEqual(expect.any(Number))
    expect(store.getEntryWithSources('ws-1', memory.id)?.updatedAt).toBe(memory.updatedAt)
    const firstInjectedAt = store.getEntryWithSources('ws-1', memory.id)?.lastInjectedAt
    const secondIds = store.logInjections({
      contextType: 'recovery',
      memoryIds: [memory.id],
      targetAgentIdSnapshot: 'worker-1',
      workspaceId: 'ws-1',
    })

    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM memory_injections').get() as { count: number })
        .count
    ).toBe(2)
    store.deleteInjections(secondIds)
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM memory_injections').get() as { count: number })
        .count
    ).toBe(1)
    expect(store.getEntryWithSources('ws-1', memory.id)?.lastInjectedAt).toBe(firstInjectedAt)
    store.deleteInjections(ids)
    expect(store.getEntryWithSources('ws-1', memory.id)?.lastInjectedAt).toBeNull()

    db.close()
  })

  test('listDigestEntries returns enabled active memory with pinned entries first', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const regular = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Regular active digest memory.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    const pinned = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Pinned digest memory.',
      kind: 'decision',
      workspaceId: 'ws-1',
    })
    const disabled = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Disabled memory must not be injected.',
      kind: 'pitfall',
      workspaceId: 'ws-1',
    })
    const archived = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Archived memory must not be injected.',
      kind: 'pitfall',
      workspaceId: 'ws-1',
    })
    const candidate = store.addEntry({
      actor: { id: 'worker-1', name: 'Alice', role: 'coder' },
      body: 'Candidate memory must not be injected.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    store.addEntry({
      actor: { id: 'ws-2:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Other workspace memory must not be injected.',
      kind: 'fact',
      workspaceId: 'ws-2',
    })

    store.setPinned('ws-1', pinned.id, true)
    store.setDisabled('ws-1', disabled.id, true)
    store.archiveEntry('ws-1', archived.id)

    expect(store.listDigestEntries('ws-1', { limit: 10 }).map((entry) => entry.id)).toEqual([
      pinned.id,
      regular.id,
    ])
    expect(store.listDigestEntries('ws-1', { limit: 1 }).map((entry) => entry.id)).toEqual([
      pinned.id,
    ])
    expect(store.getEntryWithSources('ws-1', candidate.id)?.status).toBe('candidate')

    db.close()
  })

  test('searchEntries finds active memory through FTS and CJK trigram only within a workspace', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const remote = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Remote mobile API calls must use the E2E relay path.',
      kind: 'decision',
      tags: ['remote', 'relay'],
      workspaceId: 'ws-1',
    })
    const cjk = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: '移动端访问链必须经过 relay。',
      kind: 'pitfall',
      tags: ['访问链'],
      workspaceId: 'ws-1',
    })
    store.addEntry({
      actor: { id: 'ws-2:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Remote relay belongs to ws-2 only.',
      kind: 'decision',
      tags: ['remote'],
      workspaceId: 'ws-2',
    })
    const ftsRow = db
      .prepare('SELECT fts_rowid FROM memory_entries WHERE id = ?')
      .get(remote.id) as { fts_rowid: number }

    expect(store.searchEntries('ws-1', 'remote relay').map((entry) => entry.id)).toContain(
      remote.id
    )
    expect(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM memory_fts JOIN memory_entries e ON e.fts_rowid = memory_fts.rowid WHERE e.id = ?'
          )
          .get(remote.id) as { count: number }
      ).count
    ).toBe(1)
    expect(ftsRow.fts_rowid).toEqual(expect.any(Number))
    expect(store.searchEntries('ws-1', '访问链')).toEqual([
      expect.objectContaining({
        id: cjk.id,
        indexName: 'trigram',
        sources: expect.arrayContaining([
          expect.objectContaining({
            actorAgentIdSnapshot: 'ws-1:orchestrator',
          }),
        ]),
      }),
    ])
    expect(store.searchEntries('ws-2', '访问链')).toEqual([])

    db.close()
  })

  test('user-scoped procedure memory is searchable and injectable without a workspace owner', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const memory = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'For release checklists, consult the ship skill before tagging.',
      kind: 'procedure_ref',
      procedureRef: { id: 'ship-release', title: 'Ship release', type: 'skill' },
      scope: 'user',
      tags: ['release'],
      workspaceId: 'ws-1',
    })

    expect(memory).toMatchObject({
      procedureRef: { id: 'ship-release', title: 'Ship release', type: 'skill' },
      scope: 'user',
      workspaceId: null,
    })
    expect(store.listEntries('ws-1', { scopes: ['workspace'] })).toEqual([])
    expect(store.listEntries('ws-1', { scopes: ['user'] }).map((entry) => entry.id)).toEqual([
      memory.id,
    ])
    expect(store.searchEntries('ws-2', 'release checklists', { scopes: ['workspace'] })).toEqual([])
    expect(
      store.searchEntries('ws-2', 'release checklists', { scopes: ['workspace', 'user'] })
    ).toEqual([expect.objectContaining({ id: memory.id, procedureRef: memory.procedureRef })])

    store.logInjections({
      contextType: 'dispatch',
      dispatchId: 'dispatch-user-memory',
      memoryIds: [memory.id],
      workspaceId: 'ws-2',
    })

    expect(store.getEntryWithSources('ws-2', memory.id)?.lastInjectedAt).toEqual(expect.any(Number))
    expect(store.getEntryWithSources('ws-1', memory.id)?.lastInjectedAt).toBeNull()
    expect(store.listInjections('ws-2')).toEqual([
      expect.objectContaining({
        dispatchId: 'dispatch-user-memory',
        memory: expect.objectContaining({ id: memory.id, scope: 'user' }),
      }),
    ])

    db.close()
  })

  test('archiveEntry forgets from active search without deleting source evidence', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const memory = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Archive this search marker without deleting evidence.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })

    expect(store.searchEntries('ws-1', 'archive marker')).toHaveLength(1)

    const archived = store.archiveEntry('ws-1', memory.id)

    expect(archived).toEqual(
      expect.objectContaining({
        archivedAt: expect.any(Number),
        id: memory.id,
        status: 'archived',
        sources: expect.arrayContaining([
          expect.objectContaining({
            actorAgentIdSnapshot: 'ws-1:orchestrator',
            sourceType: 'manual',
          }),
        ]),
      })
    )
    expect(store.searchEntries('ws-1', 'archive marker')).toEqual([])
    expect(store.getEntryWithSources('ws-1', memory.id)).toEqual(
      expect.objectContaining({
        id: memory.id,
        status: 'archived',
        sources: expect.arrayContaining([expect.objectContaining({ sourceType: 'manual' })]),
      })
    )
    expect(() => store.archiveEntry('ws-2', memory.id)).toThrow(MemoryEntryNotFoundError)

    db.close()
  })

  test('candidate approval, rejection, pinning, and disabling update rows atomically', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const candidate = store.addEntry({
      actor: { id: 'worker-1', name: 'Alice', role: 'coder' },
      body: 'Candidate memory needs orchestrator approval.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })

    expect(store.approveCandidate('ws-1', candidate.id)).toEqual(
      expect.objectContaining({
        archivedAt: null,
        id: candidate.id,
        status: 'active',
      })
    )
    expect(store.setPinned('ws-1', candidate.id, true)).toEqual(
      expect.objectContaining({
        id: candidate.id,
        pinned: true,
      })
    )
    expect(store.setDisabled('ws-1', candidate.id, true)).toEqual(
      expect.objectContaining({
        disabled: true,
        id: candidate.id,
      })
    )

    const rejected = store.addEntry({
      actor: { id: 'worker-2', name: 'Bob', role: 'tester' },
      body: 'Reject this candidate memory.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    expect(store.rejectCandidate('ws-1', rejected.id)).toEqual(
      expect.objectContaining({
        id: rejected.id,
        status: 'rejected',
      })
    )
    expect(store.searchEntries('ws-1', 'Reject this')).toEqual([])

    expect(() => store.approveCandidate('ws-1', candidate.id)).toThrow(MemoryEntryStatusError)
    expect(() => store.rejectCandidate('ws-1', candidate.id)).toThrow(MemoryEntryStatusError)
    expect(() => store.setPinned('ws-2', candidate.id, true)).toThrow(MemoryEntryNotFoundError)
    expect(() => store.setDisabled('ws-1', 'missing-memory', true)).toThrow(
      MemoryEntryNotFoundError
    )
    expect(() => store.setPinned('ws-1', rejected.id, true)).toThrow(MemoryEntryStatusError)
    expect(() => store.setDisabled('ws-1', rejected.id, true)).toThrow(MemoryEntryStatusError)

    db.close()
  })

  test('archiveEntry is active-only and repeated archive is idempotent', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const active = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Active memory can be archived once.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    const candidate = store.addEntry({
      actor: { id: 'worker-1', name: 'Alice', role: 'coder' },
      body: 'Candidate memory cannot be forgotten before review.',
      kind: 'fact',
      workspaceId: 'ws-1',
    })

    expect(() => store.archiveEntry('ws-1', candidate.id)).toThrow(MemoryEntryStatusError)

    const archived = store.archiveEntry('ws-1', active.id)
    const archivedAgain = store.archiveEntry('ws-1', active.id)

    expect(archivedAgain).toEqual(archived)
    expect(() => store.archiveEntry('ws-2', active.id)).toThrow(MemoryEntryNotFoundError)

    db.close()
  })

  test('logInjections rejects cross-workspace memory ids and rolls back the whole audit write', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const left = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Memory scoped to ws-1',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    const right = store.addEntry({
      actor: { id: 'ws-2:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Memory scoped to ws-2',
      kind: 'fact',
      workspaceId: 'ws-2',
    })

    let caught: unknown
    try {
      store.logInjections({
        contextType: 'dispatch',
        dispatchId: 'dispatch-1',
        memoryIds: [left.id, right.id],
        targetAgentIdSnapshot: 'worker-1',
        workspaceId: 'ws-1',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(MemoryEntryNotFoundError)
    expect(caught).toMatchObject({
      memoryId: right.id,
      workspaceId: 'ws-1',
    })

    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM memory_injections').get() as { count: number })
        .count
    ).toBe(0)
    expect(store.getEntryWithSources('ws-1', left.id)?.lastInjectedAt).toBeNull()

    db.close()
  })

  test('deleteWorkspaceMemories removes workspace memory rows without touching other workspaces', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createTeamMemoryStore(db)
    const left = store.addEntry({
      actor: { id: 'ws-1:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Memory scoped to ws-1',
      kind: 'fact',
      workspaceId: 'ws-1',
    })
    const right = store.addEntry({
      actor: { id: 'ws-2:orchestrator', name: 'Queen', role: 'orchestrator' },
      body: 'Memory scoped to ws-2',
      kind: 'fact',
      workspaceId: 'ws-2',
    })
    store.logInjections({
      contextType: 'dispatch',
      dispatchId: 'dispatch-1',
      memoryIds: [left.id],
      targetAgentIdSnapshot: 'worker-1',
      workspaceId: 'ws-1',
    })
    db.prepare(
      `INSERT INTO memory_injections (
        id,
        memory_id,
        workspace_id,
        context_type,
        injected_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('orphan-injection-1', right.id, 'ws-1', 'startup', 1)
    db.prepare(
      `INSERT INTO memory_injections (
        id,
        memory_id,
        workspace_id,
        context_type,
        injected_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('orphan-injection-2', left.id, 'ws-2', 'startup', 1)

    store.deleteWorkspaceMemories('ws-1')

    expect(store.getEntryWithSources('ws-1', left.id)).toBeUndefined()
    expect(store.getEntryWithSources('ws-2', right.id)).toEqual(right)
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?')
          .get(left.id) as {
          count: number
        }
      ).count
    ).toBe(0)
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM memory_injections WHERE memory_id = ?')
          .get(left.id) as {
          count: number
        }
      ).count
    ).toBe(0)
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM memory_injections WHERE memory_id = ?')
          .get(left.id) as {
          count: number
        }
      ).count
    ).toBe(0)
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM memory_injections WHERE workspace_id = ?')
          .get('ws-1') as {
          count: number
        }
      ).count
    ).toBe(0)

    db.close()
  })
})
