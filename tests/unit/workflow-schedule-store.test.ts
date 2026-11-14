import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkflowScheduleStore } from '../../src/server/workflow-schedule-store.js'

const make = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createWorkflowScheduleStore(db)
}

describe('workflow-schedule-store', () => {
  test('creates a schedule and reads it back', () => {
    const store = make()
    const s = store.create({
      workspaceId: 'ws-1',
      scriptPath: '.hive/workflows/review.ts',
      cron: '0 9 * * 1',
      nextRunAt: 1_700_000_000_000,
      args: { x: 1 },
    })
    expect(s.enabled).toBe(true)
    expect(s.args).toEqual({ x: 1 })
    const fetched = store.get(s.id)
    expect(fetched?.cron).toBe('0 9 * * 1')
    expect(fetched?.nextRunAt).toBe(1_700_000_000_000)
  })

  test('updates enabled, cron, nextRunAt, lastRunAt', () => {
    const store = make()
    const s = store.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '*/5 * * * *',
      nextRunAt: 100,
    })
    store.update(s.id, { enabled: false, lastRunAt: 50, nextRunAt: 200, cron: '0 * * * *' })
    const r = store.get(s.id)
    expect(r?.enabled).toBe(false)
    expect(r?.lastRunAt).toBe(50)
    expect(r?.nextRunAt).toBe(200)
    expect(r?.cron).toBe('0 * * * *')
  })

  test('lists only the workspace own schedules', () => {
    const store = make()
    store.create({ workspaceId: 'ws', scriptPath: 'a', cron: '* * * * *', nextRunAt: 1 })
    store.create({ workspaceId: 'ws', scriptPath: 'b', cron: '* * * * *', nextRunAt: 1 })
    store.create({ workspaceId: 'other', scriptPath: 'c', cron: '* * * * *', nextRunAt: 1 })
    const list = store.listForWorkspace('ws')
    // Order between same-ms inserts breaks on UUID tiebreaker, so compare as
    // a set. Workspace isolation is what matters.
    expect(new Set(list.map((s) => s.scriptPath))).toEqual(new Set(['a', 'b']))
  })

  test('listDueSchedules returns enabled schedules whose nextRunAt <= now', () => {
    const store = make()
    const past = store.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    store.create({
      workspaceId: 'ws',
      scriptPath: 'q',
      cron: '* * * * *',
      nextRunAt: 10_000_000_000_000,
    })
    const disabled = store.create({
      workspaceId: 'ws',
      scriptPath: 'r',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    store.update(disabled.id, { enabled: false })

    const due = store.listDueSchedules(500)
    expect(due.map((s) => s.id)).toEqual([past.id])
  })

  test('deletes a schedule', () => {
    const store = make()
    const s = store.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '* * * * *',
      nextRunAt: 1,
    })
    store.deleteSchedule(s.id)
    expect(store.get(s.id)).toBeUndefined()
  })
})
