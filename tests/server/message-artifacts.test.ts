import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('message artifacts', () => {
  test('report messages persist artifacts for recovery/debugging', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.dispatchTask(workspace.id, worker.id, 'Implement login')
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
