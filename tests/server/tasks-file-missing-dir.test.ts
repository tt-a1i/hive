import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createTasksFileService } from '../../src/server/tasks-file.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('tasks file missing directory', () => {
  test('readTasks creates parent workspace dir when it does not exist yet', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hive-tasks-missing-dir-'))
    tempDirs.push(rootDir)

    const workspacePath = join(rootDir, 'workspace-not-created-yet')
    const service = createTasksFileService()

    expect(service.readTasks(workspacePath)).toBe('')
  })
})
