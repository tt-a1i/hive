import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { waitForDispatchDelivery } from '../helpers/dispatch-delivery.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'

test.each([
  false,
  true,
])('startup replay respects persisted delivery completion (%s)', async (delivered) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-replay-submitted-'))
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  try {
    server = await startTestServer({ dataDir })
    const receivedPath = join(dataDir, 'worker-input.log')
    const workspace = server.store.createWorkspace(dataDir, 'Replay')
    const worker = server.store.addWorker(workspace.id, { name: 'Cara', role: 'coder' })
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    let dispatchId: string
    try {
      const ledger = createDispatchLedgerStore(db)
      const dispatch = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        fromAgentId: `${workspace.id}:orchestrator`,
        text: 'replay completion contract',
      })
      dispatchId = dispatch.id
      expect(ledger.claimQueuedDispatch(dispatchId)).toBe(true)
      if (delivered)
        ledger.markDelivered({ dispatchId, deliveredAt: 1234, dispatchPayloadBytes: 42 })
    } finally {
      db.close()
    }
    await server.close()
    server = undefined
    server = await startTestServer({ dataDir })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{fs.appendFileSync(${JSON.stringify(receivedPath)},c);process.stdout.write(c)})`,
      ],
    })
    await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    const run = server.store.getActiveRunByAgentId(workspace.id, worker.id)
    const output = () => (existsSync(receivedPath) ? readFileSync(receivedPath, 'utf8') : '')
    await run?.postStartInputReady
    await waitForDispatchDelivery(server.store, workspace.id, dispatchId)
    const marker = '<hive-message kind="dispatch" from="@Orchestrator">'
    if (delivered) {
      if (!run) throw new Error('Expected worker run')
      server.store.writeRunInput(run.runId, 'REPLAY_DRAIN_BARRIER\r')
      await expect.poll(output, { timeout: 8000 }).toContain('REPLAY_DRAIN_BARRIER')
      expect(output()).not.toContain(marker)
      expect(
        server.store.listDispatches(workspace.id).find((item) => item.id === dispatchId)
      ).toMatchObject({ status: 'submitted', deliveredAt: 1234, dispatchPayloadBytes: 42 })
    } else {
      await expect.poll(output, { timeout: 8000 }).toContain(marker)
      expect(output()).toContain(`dispatch_id: ${dispatchId}`)
      expect(output().split(marker)).toHaveLength(2)
      expect(
        server.store.listDispatches(workspace.id).find((item) => item.id === dispatchId)?.status
      ).toBe('submitted')
    }
  } finally {
    await server?.close()
    removeTestPath(dataDir)
  }
}, 20000)
