import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('runtime rehydration stopped status', () => {
  test('runtime reload starts workers as stopped regardless of pending count', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-rehydrate-stopped-'))
    tempDirs.push(dataDir)
    const firstStore = createRuntimeStore({ dataDir })
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    firstStore.dispatchTask(workspace.id, worker.id, 'Implement login')

    const secondStore = createRuntimeStore({ dataDir })
    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, pendingTaskCount: 1, status: 'stopped' })
    )
  })
})
