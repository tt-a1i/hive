import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import chokidar from 'chokidar'
import { afterEach, describe, expect, test, vi } from 'vitest'

const fakeWatchers: FakeWatcher[] = []
let autoReady = true

class FakeWatcher extends EventEmitter {
  closeCalls = 0

  async close() {
    this.closeCalls += 1
  }
}

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const watcher = new FakeWatcher()
      fakeWatchers.push(watcher)
      if (autoReady) setTimeout(() => watcher.emit('ready'), 0)
      return watcher
    }),
  },
}))

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  autoReady = true
  fakeWatchers.splice(0)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 1000, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  if (lastError) throw lastError
}

describe('tasks file watcher hardening', () => {
  test('matches tasks.md watcher events case-insensitively on win32', async () => {
    const { isTasksFileEvent } = await import('../../src/server/tasks-file-watcher.js')
    expect(
      isTasksFileEvent('C:\\repo\\.hive\\tasks.md', 'c:\\repo\\.hive\\TASKS.md', 'win32')
    ).toBe(true)
    expect(isTasksFileEvent('/repo/.hive/tasks.md', '/repo/.hive/TASKS.md', 'linux')).toBe(false)
  })

  test('watches the .hive parent directory and filters to tasks.md events', async () => {
    const { createTasksFileWatcher } = await import('../../src/server/tasks-file-watcher.js')
    const workspacePath = join(tmpdir(), `hive-watch-parent-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const updates: string[] = []
    const watcher = createTasksFileWatcher({
      onTasksUpdated: (_workspaceId, content) => updates.push(content),
    })

    await watcher.start('ws-1', workspacePath)
    expect(vi.mocked(chokidar.watch).mock.calls[0]?.[0]).toBe(join(workspacePath, '.hive'))

    const fake = fakeWatchers[0]
    if (!fake) throw new Error('Expected a started watcher')
    fake.emit('change', join(workspacePath, '.hive', 'PROTOCOL.md'))
    fake.emit('change', join(workspacePath, '.hive', 'tasks.md'))

    await waitFor(() => {
      expect(updates).toEqual([''])
    })
    await watcher.close()
  })

  test('chokidar error events are handled and close the failed watcher', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createTasksFileWatcher } = await import('../../src/server/tasks-file-watcher.js')
    const workspacePath = join(tmpdir(), `hive-watch-error-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const watcher = createTasksFileWatcher({ onTasksUpdated: () => {} })

    await watcher.start('ws-1', workspacePath)
    const [fake] = fakeWatchers
    if (!fake) throw new Error('Expected a started watcher')
    fake.emit('error', new Error('permission denied'))
    await Promise.resolve()

    expect(fake.closeCalls).toBe(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('tasks watcher error for workspace ws-1'),
      expect.any(Error)
    )
    await watcher.close()
  })

  test('start times out and closes the watcher when chokidar never becomes ready', async () => {
    vi.useFakeTimers()
    autoReady = false
    const { createTasksFileWatcher, getTasksWatcherReadyTimeoutMs } = await import(
      '../../src/server/tasks-file-watcher.js'
    )
    const workspacePath = join(tmpdir(), `hive-watch-ready-timeout-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const watcher = createTasksFileWatcher({ onTasksUpdated: () => {} })

    const start = watcher.start('ws-1', workspacePath).catch((error: unknown) => error)
    const expectedTimeoutMs = getTasksWatcherReadyTimeoutMs(workspacePath)
    await vi.advanceTimersByTimeAsync(expectedTimeoutMs)
    const error = await start
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `Timed out waiting for tasks watcher ready after ${expectedTimeoutMs}ms`
    )

    expect(fakeWatchers[0]?.closeCalls).toBe(1)
    await watcher.close()
  })

  test('chokidar error events schedule a retry and rebuild the watcher', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createTasksFileWatcher } = await import('../../src/server/tasks-file-watcher.js')
    const workspacePath = join(tmpdir(), `hive-watch-retry-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const watcher = createTasksFileWatcher({ onTasksUpdated: () => {} })

    const start = watcher.start('ws-1', workspacePath)
    await vi.runOnlyPendingTimersAsync()
    await start
    const [failedWatcher] = fakeWatchers
    if (!failedWatcher) throw new Error('Expected a started watcher')

    failedWatcher.emit('error', new Error('read handle closed'))
    await Promise.resolve()

    expect(failedWatcher.closeCalls).toBe(1)
    expect(fakeWatchers).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5000)
    await vi.runOnlyPendingTimersAsync()

    expect(fakeWatchers).toHaveLength(2)
    expect(fakeWatchers[1]?.closeCalls).toBe(0)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('tasks watcher error for workspace ws-1'),
      expect.any(Error)
    )
    await watcher.close()
  })

  test('start after close does not re-arm a watcher', async () => {
    const { createTasksFileWatcher } = await import('../../src/server/tasks-file-watcher.js')
    const workspacePath = join(tmpdir(), `hive-watch-closed-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const watcher = createTasksFileWatcher({ onTasksUpdated: () => {} })

    await watcher.start('ws-1', workspacePath)
    expect(fakeWatchers).toHaveLength(1)
    await watcher.close()
    await watcher.start('ws-1', workspacePath)
    expect(fakeWatchers).toHaveLength(1)
    expect(vi.mocked(chokidar.watch)).toHaveBeenCalledTimes(1)
  })

  test('read failures during debounced emission are logged without clearing tasks', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createTasksFileWatcher } = await import('../../src/server/tasks-file-watcher.js')
    const workspacePath = join(tmpdir(), `hive-watch-read-error-${Date.now()}`)
    const tasksPath = join(workspacePath, '.hive', 'tasks.md')
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(tasksPath, '- [ ] initial\n')
    tempDirs.push(workspacePath)
    const updates: string[] = []
    const watcher = createTasksFileWatcher({
      onTasksUpdated: (_workspaceId, content) => updates.push(content),
    })

    await watcher.start('ws-1', workspacePath)
    rmSync(tasksPath)
    mkdirSync(tasksPath)
    const fake = fakeWatchers[0]
    if (!fake) throw new Error('Expected a started watcher')
    fake.emit('change')

    await waitFor(() => {
      expect(updates).toEqual([])
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('tasks watcher error for workspace ws-1'),
        expect.any(Error)
      )
    })
    await watcher.close()
  })
})
