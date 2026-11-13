import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { getTasksFilePath } from '../../src/server/tasks-file.js'
import { createTasksFileWatcher } from '../../src/server/tasks-file-watcher.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 4000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

// Drain startup emits by waiting until the count stops growing for `quietMs`,
// rather than a fixed sleep. `start()` creates tasks.md and only
// awaits chokidar 'ready'; under full-suite load a straggler fs event for those
// just-created files can land shortly AFTER 'ready' (and after a fixed drain),
// firing one spurious emit. Resetting the window on each emit absorbs that
// straggler so the sibling-file assertion starts from a clean slate.
const waitForQuiescence = async (getCount: () => number, quietMs = 300, maxMs = 4000) => {
  const deadline = Date.now() + maxMs
  let last = getCount()
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const current = getCount()
    if (current !== last) {
      last = current
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return
    }
  }
  // A watcher that never goes quiet must fail loudly — silently returning here
  // would let a misbehaving (continuously-emitting) watcher be treated as a
  // clean baseline for the assertions below.
  throw new Error(
    `tasks watcher never reached ${quietMs}ms of quiescence within ${maxMs}ms (last count ${last})`
  )
}

describe('tasks file watcher real filesystem events', () => {
  test('parent-directory watcher ignores sibling files and emits .hive/tasks.md changes', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-real-watch-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    const updates: string[] = []
    const watcher = createTasksFileWatcher({
      onTasksUpdated: (_workspaceId, content) => updates.push(content),
    })

    try {
      await watcher.start('ws-1', workspacePath)
      await waitForQuiescence(() => updates.length)
      updates.length = 0
      writeFileSync(join(workspacePath, '.hive', 'PROTOCOL.md'), 'changed protocol\n')
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(updates).toEqual([])

      writeFileSync(getTasksFilePath(workspacePath), '- [ ] real watcher update\n')
      await waitFor(() => {
        expect(updates).toContain('- [ ] real watcher update\n')
      })
    } finally {
      await watcher.close()
    }
  })

  test.runIf(process.platform === 'win32')(
    'Windows emits updates when the tasks file is written through uppercase TASKS.md',
    async () => {
      const workspacePath = mkdtempSync(join(tmpdir(), 'hive-real-watch-case-'))
      tempDirs.push(workspacePath)
      mkdirSync(join(workspacePath, '.hive'), { recursive: true })
      const updates: string[] = []
      const watcher = createTasksFileWatcher({
        onTasksUpdated: (_workspaceId, content) => updates.push(content),
      })

      try {
        await watcher.start('ws-case', workspacePath)
        await waitForQuiescence(() => updates.length)
        updates.length = 0

        writeFileSync(join(workspacePath, '.hive', 'TASKS.md'), '- [ ] uppercase event\n')

        await waitFor(() => {
          expect(updates).toContain('- [ ] uppercase event\n')
        })
      } finally {
        await watcher.close()
      }
    }
  )
})
