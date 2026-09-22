import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

describe('submitted dispatch recovery across a real runtime restart (#80)', () => {
  test.each([
    false,
    true,
  ])('replays only unfinished writes (previously delivered: %s)', async (delivered) => {
    const root = mkdtempSync(join(tmpdir(), 'hive-replay-submitted-'))
    const workspacePath = join(root, 'workspace')
    const dataDir = join(root, 'data')
    const receipt = join(root, 'stdin.txt')
    const script = join(root, 'receiver.cjs')
    mkdirSync(workspacePath)
    writeFileSync(receipt, '')
    writeFileSync(
      script,
      [
        "const { appendFileSync } = require('node:fs')",
        'process.stdin.setRawMode(true)',
        "process.stdin.setEncoding('utf8')",
        `process.stdin.on('data', data => appendFileSync(${JSON.stringify(receipt)}, data))`,
        'process.stdin.resume()',
      ].join('\n')
    )
    let server: Awaited<ReturnType<typeof startTestServer>> | undefined
    try {
      server = await startTestServer({ dataDir })
      const workspace = server.store.createWorkspace(workspacePath, 'Replay')
      const worker = server.store.addWorker(workspace.id, { name: 'Cara', role: 'coder' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: [script],
      })
      await server.close()
      server = undefined
      // Seed the precise crash boundary while no runtime owns the database.
      // No delivery implementation or PTY is mocked.
      const db = new Database(join(dataDir, 'runtime.sqlite'))
      const marker = `REPLAY_TASK_${crypto.randomUUID()}`
      const barrier = `REPLAY_BARRIER_${crypto.randomUUID()}`
      let dispatchId: string
      let barrierId: string
      try {
        const ledger = createDispatchLedgerStore(db)
        const input = {
          workspaceId: workspace.id,
          toAgentId: worker.id,
          fromAgentId: `${workspace.id}:orchestrator`,
        }
        dispatchId = ledger.createDispatch({ ...input, text: marker }).id
        expect(ledger.claimQueuedDispatch(dispatchId)).toBe(true)
        if (delivered)
          ledger.markDelivered({
            dispatchId,
            deliveredAt: Date.now(),
            dispatchPayloadBytes: Buffer.byteLength(marker),
          })
        expect(ledger.getDispatch(workspace.id, dispatchId)).toMatchObject({
          status: 'submitted',
          deliveredAt: delivered ? expect.any(Number) : null,
        })
        barrierId = ledger.createDispatch({ ...input, text: barrier }).id
      } finally {
        db.close()
      }
      server = await startTestServer({ dataDir })
      const cookie = await getUiCookie(server.baseUrl)
      const response = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(response.status).toBe(201)
      // A later queued task proves replay and the receiver ran: an empty
      // capture plus an arbitrary delay cannot pass the no-redelivery case.
      await expect.poll(() => readFileSync(receipt, 'utf8'), { timeout: 10000 }).toContain(barrier)
      const received = readFileSync(receipt, 'utf8')
      expect(received.split(marker).length - 1).toBe(delivered ? 0 : 1)
      expect(received.split(barrier).length - 1).toBe(1)
      for (const id of [dispatchId, barrierId]) {
        await expect
          .poll(() => server?.store.listDispatches(workspace.id).find((row) => row.id === id))
          .toMatchObject({ status: 'submitted', deliveredAt: expect.any(Number) })
      }
    } finally {
      await server?.close()
      removeTestPath(root)
    }
  }, 20000)
})
