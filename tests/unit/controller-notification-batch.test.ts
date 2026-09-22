import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createControllerNotifier } from '../../src/server/controller-notifier.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

// Exercises the persisted queue and a real child process, not the App or HTTP.
test.skipIf(process.platform === 'win32')(
  'notifies exact eligible IDs in bounded workspace batches',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-notification-batch-'))
    const capture = join(root, 'argv.jsonl')
    const originalPath = process.env.PATH
    const db = new Database(join(root, 'runtime.sqlite'))
    let notifier: ReturnType<typeof createControllerNotifier> | undefined
    try {
      initializeRuntimeDatabase(db)
      writeFileSync(
        join(root, 'codex'),
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n')\n`,
        { mode: 0o755 }
      )
      // No fallback to a real Codex executable is possible in this process.
      process.env.PATH = root
      const workspaceId = randomUUID()
      const otherWorkspaceId = randomUUID()
      const threadId = randomUUID()
      for (const id of [workspaceId, otherWorkspaceId]) {
        db.prepare(
          "INSERT INTO workspaces(id,name,path,created_at,controller_mode) VALUES(?,?,?,?,'codex_app')"
        ).run(id, id, root, Date.now())
        db.prepare('INSERT INTO workspace_controllers(workspace_id,thread_id) VALUES(?,?)').run(
          id,
          id === workspaceId ? threadId : randomUUID()
        )
      }
      const insert =
        db.prepare(`INSERT INTO report_outbox(workspace_id,target_agent_id,dispatch_id,payload,created_at,read_at,delivered_at)
      VALUES(?,?,?,?,?,?,?)`)
      const receipt = (
        workspace: string,
        readAt: number | null = null,
        acknowledgedAt: number | null = null
      ) =>
        Number(
          insert.run(
            workspace,
            `${workspace}:orchestrator`,
            randomUUID(),
            'fixture receipt',
            Date.now(),
            readAt,
            acknowledgedAt
          ).lastInsertRowid
        )
      const readId = receipt(workspaceId, Date.now())
      const acknowledgedId = receipt(workspaceId, Date.now(), Date.now())
      const eligibleIds = Array.from({ length: 103 }, () => receipt(workspaceId))
      const otherId = receipt(otherWorkspaceId)
      const states = () =>
        db.prepare('SELECT id,notification_state FROM report_outbox ORDER BY id').all() as Array<{
          id: number
          notification_state: string
        }>
      const acceptedIds = () =>
        states()
          .filter((row) => row.notification_state === 'accepted')
          .map((row) => row.id)
      const capturedArgs = () =>
        readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
      const notifiedIds = (args: string[] | undefined) => {
        if (!args) throw new Error('Expected captured notification arguments')
        expect(args.slice(0, 4)).toEqual(['queue', '--thread', threadId, '--message'])
        const match = args[4]?.match(/report_ids=(\[[\d,]+\])/)
        expect(match).not.toBeNull()
        return JSON.parse(match?.[1] ?? 'null') as number[]
      }
      notifier = createControllerNotifier(db)
      notifier.notify()
      await expect.poll(acceptedIds).toEqual(eligibleIds.slice(0, 100))
      expect(capturedArgs()).toHaveLength(1)
      expect(notifiedIds(capturedArgs()[0])).toEqual(eligibleIds.slice(0, 100))
      expect(
        states()
          .filter((row) => row.notification_state === 'pending')
          .map((row) => row.id)
      ).toEqual([readId, acknowledgedId, ...eligibleIds.slice(100), otherId])

      notifier.notify()
      await expect.poll(acceptedIds).toEqual(eligibleIds)
      expect(capturedArgs()).toHaveLength(2)
      expect(notifiedIds(capturedArgs()[1])).toEqual(eligibleIds.slice(100))
      expect(
        states()
          .filter((row) => row.notification_state === 'pending')
          .map((row) => row.id)
      ).toEqual([readId, acknowledgedId, otherId])
    } finally {
      await notifier?.close()
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
