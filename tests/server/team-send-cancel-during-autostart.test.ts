import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConflictError } from '../../src/server/http-errors.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

describe('team send vs cancel during auto-start (#78)', () => {
  test('rejects a send cancelled during real PTY startup and never delivers its task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-send-cancel-start-'))
    const workspacePath = join(root, 'workspace')
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
      server = await startTestServer({ dataDir: join(root, 'data') })
      const { store, baseUrl } = server
      const workspace = store.createWorkspace(workspacePath, 'Auto-start cancellation')
      const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      const fromAgentId = `${workspace.id}:orchestrator`
      store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: [script],
      })
      const marker = `CANCELLED_TASK_${crypto.randomUUID()}`
      const barrier = `LATER_TASK_${crypto.randomUUID()}`
      expect(store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
      // Do not await the send: cancellation runs at its real startup await
      // boundary. No fake runtime, deferred spawn stub, or timing sleep.
      const sending = store.dispatchTask(workspace.id, worker.id, marker, {
        fromAgentId,
        autoStartWorker: true,
        hivePort: new URL(baseUrl).port,
      })
      const rejected = expect(sending).rejects.toBeInstanceOf(ConflictError)
      const created = store.listDispatches(workspace.id).find((row) => row.text === marker)
      if (!created) throw new Error('Expected the pending dispatch before startup settles')
      expect(created.status).toBe('queued')
      await store.cancelTask(workspace.id, created.id, {
        fromAgentId,
        reason: 'user cancelled',
      })
      await rejected
      const later = await store.dispatchTask(workspace.id, worker.id, barrier, { fromAgentId })
      // Positive receipt proves the actual spawned process and input queue ran.
      await expect.poll(() => readFileSync(receipt, 'utf8'), { timeout: 10000 }).toContain(barrier)
      const received = readFileSync(receipt, 'utf8')
      expect(received).not.toContain(marker)
      expect(received.split(barrier).length - 1).toBe(1)
      await expect
        .poll(() => store.listDispatches(workspace.id).find((row) => row.id === later.id))
        .toMatchObject({ status: 'submitted', deliveredAt: expect.any(Number) })
      const cookie = await getUiCookie(baseUrl)
      const history = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`, {
        headers: { cookie },
      })
      expect(history.status).toBe(200)
      expect(await history.json()).toContainEqual(
        expect.objectContaining({
          id: created.id,
          state: 'cancelled',
          report_text: 'user cancelled',
        })
      )
    } finally {
      await server?.close()
      removeTestPath(root)
    }
  }, 20000)
})
