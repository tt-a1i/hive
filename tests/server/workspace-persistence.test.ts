import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('workspace persistence', () => {
  test('reloads workspaces from sqlite-backed storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hive-store-'))
    tempDirs.push(tempDir)

    const firstStore = createRuntimeStore({ dataDir: tempDir })
    firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    firstStore.createWorkspace('/tmp/hive-beta', 'Beta')

    const secondStore = createRuntimeStore({ dataDir: tempDir })

    expect(secondStore.listWorkspaces()).toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/hive-alpha',
      },
      {
        id: expect.any(String),
        name: 'Beta',
        path: '/tmp/hive-beta',
      },
    ])
  })
})
