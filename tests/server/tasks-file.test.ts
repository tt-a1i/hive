import { mkdirSync, rmSync } from 'node:fs'
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

describe('tasks file service', () => {
  test('creates tasks.md on first read and persists writes', () => {
    const workspacePath = join(tmpdir(), `hive-tasks-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)

    const service = createTasksFileService()

    expect(service.readTasks(workspacePath)).toBe('')

    service.writeTasks(workspacePath, '- [ ] implement login\n')

    expect(service.readTasks(workspacePath)).toBe('- [ ] implement login\n')
  })
})
