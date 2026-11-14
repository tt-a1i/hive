import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { ConflictError } from '../../src/server/http-errors.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

describe('team send authorization', () => {
  test('dispatchTaskByWorkerName leaves state unchanged when worker has no launch config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-send-no-config-'))
    const store = createRuntimeStore({ dataDir })
    try {
      const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Alpha')
      const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

      await expect(
        store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Implement login', {
          fromAgentId: bob.id,
        })
      ).rejects.toBeInstanceOf(ConflictError)

      expect(store.listWorkers(workspace.id)).toContainEqual(
        expect.objectContaining({ id: alice.id, pendingTaskCount: 0 })
      )
    } finally {
      try {
        await store.close()
      } finally {
        removeTestPath(dataDir)
      }
    }
  })
})
