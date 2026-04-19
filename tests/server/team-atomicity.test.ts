import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('team atomicity', () => {
  test('dispatchTask rolls back pending count and message when PTY write fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    expect(() =>
      store.dispatchTask(workspace.id, worker.id, 'Implement login', {
        fromAgentId: `${workspace.id}:orchestrator`,
      })
    ).toThrow()

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'idle',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0)).toEqual([])
  })

  test('reportTask with requireActiveRun throws and leaves pending count + messages untouched when orch run is absent', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    // Dispatch first so pendingTaskCount rises to 1 — gives reportTask something to decrement.
    store.dispatchTask(workspace.id, worker.id, 'Implement login')
    const beforeMessages = store.listMessagesForRecovery(workspace.id, 0).length

    // Now request a report that REQUIRES an active orchestrator run. There is none,
    // so writeReportPrompt will throw. Nothing downstream (insertMessage, markTaskReported)
    // must run.
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: 'Done',
        requireActiveRun: true,
      })
    ).toThrow()

    // pending count stays at 1 (no decrement), messages list unchanged.
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0).length).toBe(beforeMessages)
  })
})
