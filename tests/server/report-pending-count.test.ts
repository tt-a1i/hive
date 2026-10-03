import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { startPassiveTestWorker, waitForDispatchDelivery } from '../helpers/dispatch-delivery.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const roots: string[] = []
const stores: ReturnType<typeof createRuntimeStore>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) removeTestPath(root)
})

describe('report pending count', () => {
  test('report decrements pending count instead of forcing zero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-report-count-'))
    roots.push(root)
    const store = createRuntimeStore({ agentManager: createAgentManager() })
    stores.push(store)
    const workspace = store.createWorkspace(root, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    await startPassiveTestWorker(store, workspace.id, worker.id)
    const first = await store.dispatchTask(workspace.id, worker.id, 'Task 1', {
      fromAgentId: `${workspace.id}:orchestrator`,
    })
    await store.dispatchTask(workspace.id, worker.id, 'Task 2', {
      fromAgentId: `${workspace.id}:orchestrator`,
    })
    await waitForDispatchDelivery(store, workspace.id, first.id)
    store.reportTask(workspace.id, worker.id, {
      dispatchId: first.id,
      status: 'success',
      text: 'Done one',
    })

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
  })
})
