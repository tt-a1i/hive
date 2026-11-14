import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []
const stores: RuntimeStore[] = []

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('runtime rehydration stopped status', () => {
  test('runtime reload starts workers as stopped regardless of pending count', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-rehydrate-stopped-'))
    tempDirs.push(dataDir)
    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    firstStore.dispatchTask(workspace.id, worker.id, 'Implement login')

    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)
    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, pendingTaskCount: 1, status: 'stopped' })
    )
  })
})
