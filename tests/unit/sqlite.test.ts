import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LegacyDatabase from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

describe('built-in SQLite storage contract', () => {
  test('preserves the original error when SQLite rolls back the transaction itself', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
      expect(
        db.transaction(() => {
          db.prepare('INSERT INTO items VALUES (?)').run(1)
          db.transaction(() => db.prepare('INSERT OR ROLLBACK INTO items VALUES (?)').run(1))()
        })
      ).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 1555 }))
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 0 })
      expect(
        db.transaction(() => db.prepare('INSERT INTO items VALUES (?)').run(2))().changes
      ).toBe(1)
    } finally {
      db.close()
    }
  })
  test('commits results and rolls nested mutations back independently', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
      const insert = db.prepare('INSERT INTO items VALUES (?, ?)')
      const failure = new Error('abort inner mutation')
      const inner = db.transaction(() => {
        insert.run(2, 'discard')
        throw failure
      })
      const outer = db.transaction((value: string) => {
        insert.run(1, value)
        expect(inner).toThrow(failure)
        insert.run(3, 'after nested rollback')
        return 42
      })
      expect(outer('keep')).toBe(42)
      expect(db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual([
        { id: 1, value: 'keep' },
        { id: 3, value: 'after nested rollback' },
      ])
      expect(
        db.transaction(() => {
          db.transaction(() => insert.run(4, 'inner committed'))()
          throw failure
        })
      ).toThrow(failure)
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 2 })
      expect(insert.run(5, 'connection still usable').changes).toBe(1)
    } finally {
      db.close()
    }
  })

  test('rolls back accidental asynchronous callbacks', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE items (id INTEGER)')
      expect(
        db.transaction(() => {
          db.prepare('INSERT INTO items VALUES (?)').run(1)
          return Promise.resolve(1)
        })
      ).toThrow(TypeError)
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  test('preserves legacy files across migrations, FTS queries and reverse driver reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-sqlite-interop-'))
    const path = join(root, 'runtime.sqlite')
    try {
      const legacy = new LegacyDatabase(path)
      const reportText = 'preserved searchable report 用户已有的数据'
      const fixture = (() => {
        try {
          expect(legacy.pragma('foreign_keys', { simple: true })).toBe(1)
          legacy.pragma('journal_mode = WAL')
          // Only bridge the private class type: every schema/store call below runs
          // against the real old driver, with no new-driver connection or mock.
          const oldDb = legacy as unknown as Database
          initializeRuntimeDatabase(oldDb)
          const workspaces = createWorkspaceStore(oldDb, [])
          const workspace = workspaces.createWorkspace(root, 'existing Hive workspace')
          const worker = workspaces.addWorker(workspace.id, {
            name: 'existing worker',
            role: 'coder',
          })
          const orchestrator = workspaces
            .getWorkspaceSnapshot(workspace.id)
            .agents.find((agent) => agent.role === 'orchestrator')
          if (!orchestrator) throw new Error('Legacy workspace must have an orchestrator')
          const ledger = createDispatchLedgerStore(oldDb)
          const dispatch = ledger.createDispatch({
            workspaceId: workspace.id,
            toAgentId: worker.id,
            text: 'existing dispatch task',
          })
          expect(ledger.claimQueuedDispatch(dispatch.id)).toBe(true)
          const reported = ledger.markReportedByWorker({
            workspaceId: workspace.id,
            toAgentId: worker.id,
            dispatchId: dispatch.id,
            reportText,
            artifacts: ['result.md'],
          })
          expect(reported).toMatchObject({
            id: dispatch.id,
            status: 'reported',
            reportText,
            artifacts: ['result.md'],
          })
          createMessageLogStore(oldDb).insertMessage({
            workspaceId: workspace.id,
            workerId: worker.id,
            fromAgentId: worker.id,
            type: 'report',
            text: reportText,
            artifacts: ['result.md'],
            createdAt: Date.now(),
          })
          createReportOutboxStore(oldDb).enqueue({
            workspaceId: workspace.id,
            targetAgentId: orchestrator.id,
            dispatchId: dispatch.id,
            payload: reportText,
          })
          return { workspace, worker, dispatch, orchestrator }
        } finally {
          legacy.close()
        }
      })()
      const { workspace, worker, dispatch, orchestrator } = fixture
      const migrated = openRuntimeDatabase(root)
      try {
        const restored = createWorkspaceStore(migrated, [])
        expect(restored.listWorkspaces()).toEqual([workspace])
        expect(restored.listWorkers(workspace.id)).toEqual([
          expect.objectContaining({ id: worker.id, name: 'existing worker', role: 'coder' }),
        ])
        expect(
          createDispatchLedgerStore(migrated).getDispatch(workspace.id, dispatch.id)
        ).toMatchObject({
          id: dispatch.id,
          text: 'existing dispatch task',
          status: 'reported',
          reportText,
          artifacts: ['result.md'],
          rootDispatchId: dispatch.id,
        })
        expect(createMessageLogStore(migrated).listMessagesForRecovery(workspace.id, 0)).toEqual([
          expect.objectContaining({
            type: 'report',
            text: reportText,
            from: worker.id,
            artifacts: ['result.md'],
          }),
        ])
        const outbox = createReportOutboxStore(migrated)
        const pending = outbox.listPending(workspace.id, orchestrator.id)
        expect(pending).toEqual([
          expect.objectContaining({
            dispatchId: dispatch.id,
            payload: reportText,
            deliveredAt: null,
          }),
        ])
        expect(
          migrated
            .prepare(
              "SELECT text FROM messages_fts_trigram WHERE messages_fts_trigram MATCH 'searchable'"
            )
            .get()
        ).toEqual({ text: reportText })
        expect(
          migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get()
        ).toEqual({ version: 45 })
        expect(migrated.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
        migrated.transaction(() => {
          restored.updateWorkerProfile(workspace.id, worker.id, { name: 'new driver worker' })
          for (const report of pending) outbox.markDelivered(report.id)
        })()
      } finally {
        migrated.close()
      }
      const reopened = new LegacyDatabase(path, { readonly: true })
      try {
        expect(reopened.prepare('SELECT name FROM workers WHERE id = ?').get(worker.id)).toEqual({
          name: 'new driver worker',
        })
        expect(
          reopened
            .prepare('SELECT report_text, artifacts FROM dispatches WHERE id = ?')
            .get(dispatch.id)
        ).toEqual({ report_text: reportText, artifacts: JSON.stringify(['result.md']) })
        expect(
          reopened.prepare('SELECT text FROM messages WHERE workspace_id = ?').all(workspace.id)
        ).toEqual([{ text: reportText }])
        expect(
          reopened
            .prepare('SELECT delivered_at FROM report_outbox WHERE dispatch_id = ?')
            .get(dispatch.id)
        ).toEqual({ delivered_at: expect.any(Number) })
        expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok')
      } finally {
        reopened.close()
      }
      const readonly = new Database(path, { readOnly: true })
      try {
        expect(() =>
          readonly.prepare('UPDATE workers SET name = ? WHERE id = ?').run('blocked', worker.id)
        ).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 8 }))
      } finally {
        readonly.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
