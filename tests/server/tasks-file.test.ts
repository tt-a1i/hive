import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  test('round-trips Chinese, emoji, punctuation, links, backticks, and newlines as UTF-8', () => {
    const workspacePath = join(tmpdir(), `hive-tasks-unicode-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const content = [
      '# 任务 🚀',
      '',
      '- [ ] 中文，标点。 English `code`',
      '- [x] [链接](https://example.com/路径?q=测试)',
      '',
    ].join('\n')
    const service = createTasksFileService()

    service.writeTasks(workspacePath, content)

    expect(service.readTasks(workspacePath)).toBe(content)
    expect(readFileSync(join(workspacePath, '.hive', 'tasks.md'))).toEqual(
      Buffer.from(content, 'utf8')
    )
  })

  test('creates .hive/tasks.md on first read and persists writes there', () => {
    const workspacePath = join(tmpdir(), `hive-tasks-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const tasksPath = join(workspacePath, '.hive', 'tasks.md')

    const service = createTasksFileService()

    expect(service.readTasks(workspacePath)).toBe('')
    expect(existsSync(tasksPath)).toBe(true)
    expect(existsSync(join(workspacePath, 'tasks.md'))).toBe(false)

    service.writeTasks(workspacePath, '- [ ] implement login\n')

    expect(service.readTasks(workspacePath)).toBe('- [ ] implement login\n')
    expect(readFileSync(tasksPath, 'utf8')).toBe('- [ ] implement login\n')
    const hiveDirEntries = readdirSync(join(workspacePath, '.hive'))
    expect(hiveDirEntries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('copies legacy root tasks.md into .hive/tasks.md without rewriting the root file', () => {
    const workspacePath = join(tmpdir(), `hive-tasks-legacy-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const legacyPath = join(workspacePath, 'tasks.md')
    const hiveTasksPath = join(workspacePath, '.hive', 'tasks.md')
    writeFileSync(legacyPath, '- [ ] legacy task\n', 'utf8')

    const service = createTasksFileService()

    expect(service.readTasks(workspacePath)).toBe('- [ ] legacy task\n')
    expect(readFileSync(hiveTasksPath, 'utf8')).toBe('- [ ] legacy task\n')

    service.writeTasks(workspacePath, '- [x] new hive task\n')

    expect(readFileSync(hiveTasksPath, 'utf8')).toBe('- [x] new hive task\n')
    expect(readFileSync(legacyPath, 'utf8')).toBe('- [ ] legacy task\n')
  })
})
