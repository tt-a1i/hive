import { describe, expect, test, vi } from 'vitest'

import { writeSystemMessage } from '../../src/server/restart-policy-support.js'

describe('restart-policy message rollback', () => {
  test('writeSystemMessage removes the persisted message when the async write fails', async () => {
    const deleted: number[] = []

    writeSystemMessage({
      deleteMessage: (handle) => {
        deleted.push(handle.sequence)
      },
      insertMessage: () => ({ sequence: 42 }),
      record: {
        createdAt: 1,
        text: 'recovery',
        type: 'system_recovery_summary',
        workerId: 'agent-1',
        workspaceId: 'ws',
      },
      runId: 'run-1',
      text: 'recovery',
      writeToRun: async () => {
        throw new Error('run is gone')
      },
    })

    await vi.waitFor(() => {
      expect(deleted).toEqual([42])
    })
  })
})
