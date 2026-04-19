import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('team send authorization', () => {
  test('dispatchTaskByWorkerName leaves state unchanged when sender has no active run', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

    expect(() =>
      store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Implement login', {
        fromAgentId: bob.id,
      })
    ).toThrow(/No active run/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: alice.id,
        pendingTaskCount: 0,
      })
    )
  })
})
