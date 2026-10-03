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

describe('message artifacts', () => {
  test('report messages persist artifacts for recovery/debugging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-message-artifacts-'))
    roots.push(root)
    const store = createRuntimeStore({ agentManager: createAgentManager() })
    stores.push(store)
    const workspace = store.createWorkspace(root, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    await startPassiveTestWorker(store, workspace.id, worker.id)
    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Implement login', {
      fromAgentId: `${workspace.id}:orchestrator`,
    })
    await waitForDispatchDelivery(store, workspace.id, dispatch.id)
    store.reportTask(workspace.id, worker.id, {
      status: 'success',
      text: '已完成登录接口',
      artifacts: ['src/auth.ts'],
    })

    const messages = store.listMessagesForRecovery(workspace.id, 0)
    expect(messages).toContainEqual(
      expect.objectContaining({
        artifacts: ['src/auth.ts'],
        text: '已完成登录接口',
        type: 'report',
      })
    )
  })
})
