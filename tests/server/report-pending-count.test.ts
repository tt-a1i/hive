import { describe, expect, test } from 'vitest'

import { startReportWorker } from '../helpers/report-worker.js'

describe('report pending count', () => {
  test('a delivered task can be reported while the orchestrator is offline', async () => {
    const { store, workspace, worker, send, report } = await startReportWorker()
    const dispatch = await send('Implement login')
    const beforeMessages = store.listMessagesForRecovery(workspace.id, 0).length

    const response = await report(dispatch.id, 'Done')
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      ok: true,
      forwarded: false,
      delivery_state: 'queued',
      dispatch_id: dispatch.id,
    })
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ id: dispatch.id, status: 'reported', reportText: 'Done' })
    )
    expect(store.getWorker(workspace.id, worker.id)).toMatchObject({
      pendingTaskCount: 0,
      status: 'idle',
    })
    expect(store.listMessagesForRecovery(workspace.id, 0)).toHaveLength(beforeMessages + 1)
  })

  test('report decrements pending count instead of forcing zero', async () => {
    const { store, workspace, worker, send, report } = await startReportWorker()

    const first = await send('Task 1')
    const second = await send('Task 2')
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(2)
    const response = await report(first.id, 'Done one')
    expect(response.status).toBe(202)
    expect(store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'reported' }),
      expect.objectContaining({ id: second.id, status: 'submitted' }),
    ])

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
  })
})
