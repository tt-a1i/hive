import { describe, expect, test } from 'vitest'

import { startReportWorker } from '../helpers/report-worker.js'

describe('message artifacts', () => {
  test('report messages persist artifacts for recovery/debugging', async () => {
    const { store, workspace, send, report } = await startReportWorker()

    const dispatch = await send('Implement login')
    const response = await report(dispatch.id, '已完成登录接口', ['src/auth.ts'])
    expect(response.status).toBe(202)
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ id: dispatch.id, status: 'reported' })
    )

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
