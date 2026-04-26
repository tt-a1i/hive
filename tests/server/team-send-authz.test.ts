import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('team send authorization', () => {
  test('dispatchTaskByWorkerName leaves state unchanged when worker has no launch config', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

    await expect(
      store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Implement login', {
        fromAgentId: bob.id,
      })
    ).rejects.toThrow(/No worker launch config available/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: alice.id,
        pendingTaskCount: 0,
      })
    )
  })
})
