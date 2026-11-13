import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { Database } from '../../src/server/sqlite.js'

let db: Database
let store: ReturnType<typeof createReportOutboxStore>

const ORCH = 'ws-1:orchestrator'

beforeEach(() => {
  db = openRuntimeDatabase()
  store = createReportOutboxStore(db)
})

afterEach(() => {
  db.close()
})

describe('report outbox store', () => {
  test('enqueued reports come back pending, oldest first', () => {
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'first' })
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd2', payload: 'second' })

    const pending = store.listPending('ws-1', ORCH)
    expect(pending.map((e) => e.dispatchId)).toEqual(['d1', 'd2'])
    expect(pending.map((e) => e.payload)).toEqual(['first', 'second'])
    expect(store.pendingCount('ws-1', ORCH)).toBe(2)
  })

  test('a dispatch enqueues at most once', () => {
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'first' })
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'dupe' })

    const pending = store.listPending('ws-1', ORCH)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.payload).toBe('first')
  })

  test('markDelivered drops an entry from the pending set', () => {
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'first' })
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd2', payload: 'second' })

    const [first] = store.listPending('ws-1', ORCH)
    store.markDelivered(first?.id ?? -1)

    expect(store.listPending('ws-1', ORCH).map((e) => e.dispatchId)).toEqual(['d2'])
    expect(store.pendingCount('ws-1', ORCH)).toBe(1)
  })

  test('deletePendingForDispatch removes only undelivered entries', () => {
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'first' })
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd2', payload: 'second' })
    const [delivered] = store.listPending('ws-1', ORCH)
    store.markDelivered(delivered?.id ?? -1)

    store.deletePendingForDispatch('d1')
    store.deletePendingForDispatch('d2')

    expect(store.listPending('ws-1', ORCH)).toEqual([])
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM report_outbox WHERE dispatch_id = ?')
          .get('d1') as {
          count: number
        }
      ).count
    ).toBe(1)
  })

  test('pending is scoped per workspace and target agent', () => {
    store.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: 'd1', payload: 'a' })
    store.enqueue({
      workspaceId: 'ws-2',
      targetAgentId: 'ws-2:orchestrator',
      dispatchId: 'd2',
      payload: 'b',
    })

    expect(store.listPending('ws-1', ORCH).map((e) => e.dispatchId)).toEqual(['d1'])
    expect(store.pendingCount('ws-2', 'ws-2:orchestrator')).toBe(1)
    expect(store.pendingCount('ws-1', 'ws-1:other')).toBe(0)
  })
})

test.each([
  false,
  true,
])('ignores legacy message receipts with optional metadata columns: %s', (metadata) => {
  const legacy = new Database(':memory:')
  try {
    legacy.exec(`CREATE TABLE report_outbox (
      id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, target_agent_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      delivered_at INTEGER ${metadata ? ", event_kind TEXT DEFAULT 'dispatch_result', source_dispatch_id TEXT" : ''}
    )`)
    const outbox = createReportOutboxStore(legacy)
    for (const id of [
      'message:retired-question',
      'message:queued-question',
      'report-id',
      'drop-id',
      'exit:run:dispatch',
    ]) {
      outbox.enqueue({ workspaceId: 'ws-1', targetAgentId: ORCH, dispatchId: id, payload: id })
    }
    expect(outbox.listPending('ws-1', ORCH).map((entry) => entry.dispatchId)).toEqual([
      'report-id',
      'drop-id',
      'exit:run:dispatch',
    ])
    expect(outbox.pendingCount('ws-1', ORCH)).toBe(3)
  } finally {
    legacy.close()
  }
})
