import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('report pending count', () => {
  test('report decrements pending count instead of forcing zero', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    // Simulate PTY started before dispatching.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Task 1')
    store.dispatchTask(workspace.id, worker.id, 'Task 2')
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done one' })

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
  })
})
