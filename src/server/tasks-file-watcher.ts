import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, normalize, win32 } from 'node:path'

import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar'

import { ensureTasksFile, getTasksFilePath, HIVE_DIR_NAME, TASKS_FILE_NAME } from './tasks-file.js'

const DEBOUNCE_MS = 100
const WATCHER_RETRY_MS = 5000
const WATCHER_CLOSE_TIMEOUT_MS = 2000
const DEFAULT_WATCHER_READY_TIMEOUT_MS = 15000
const WINDOWS_WATCHER_READY_TIMEOUT_MS = 60000

/**
 * Watcher configuration. The atomic-save option matters on Windows: VS
 * Code, Cursor, Notepad++, and the editor inside Hive itself all save
 * by writing a temp file and renaming it over the target. On
 * ReadDirectoryChangesW (Windows' native fs-event backend) that rename
 * invalidates the file-handle the chokidar watcher held for the
 * single-file path, and subsequent edits would emit no events at all.
 *
 * `atomic: 100` tells chokidar to correlate an unlink+add pair within
 * a 100ms window as a single `change` event — collapsing the rename
 * into one logical "the file was modified" notification and rebinding
 * the underlying watch handle. Without it the tasks panel goes deaf
 * to changes the user makes outside the app after the first save.
 *
 * We intentionally do NOT set `awaitWriteFinish` here. It would help
 * even more on Windows (waits for the file size to stabilise before
 * emitting), but it also throttles every emission by `stabilityThreshold`
 * — clashing with continuous-write workflows (a worker streaming
 * updates into tasks.md every 100ms would never see an emit). The
 * `atomic` option alone covers atomic-save; if a future workspace
 * needs stronger settling behaviour we can promote it then.
 *
 * Keep the directory walk shallow. We watch the `.hive` parent directory
 * instead of the `tasks.md` file so atomic-save editors can replace the
 * file without making the watcher go deaf, but recursing through
 * `.hive/reports/assets` or other generated folders can consume a file
 * descriptor per asset and starve later PTY spawns. `tasks.md` is a
 * direct child of `.hive`, so depth 0 preserves the needed events without
 * walking binary artifact trees.
 *
 * Exported so the configuration is testable in isolation.
 */
export const TASKS_WATCHER_OPTIONS: ChokidarOptions = {
  atomic: 100,
  depth: 0,
  ignoreInitial: true,
}

const isWindowsUncPath = (path: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/u.test(path)

const normalizeWatchPath = (path: string, platform: NodeJS.Platform) => {
  const normalized = platform === 'win32' ? win32.normalize(path) : normalize(path)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

const getTasksWatchPath = (workspacePath: string, platform: NodeJS.Platform) =>
  platform === 'win32'
    ? win32.join(workspacePath, HIVE_DIR_NAME, TASKS_FILE_NAME)
    : getTasksFilePath(workspacePath)

const createTasksWatcherIgnored = (
  workspacePath: string,
  platform: NodeJS.Platform
): Exclude<ChokidarOptions['ignored'], undefined> => {
  const tasksPath = getTasksWatchPath(workspacePath, platform)
  const hiveDir = platform === 'win32' ? win32.dirname(tasksPath) : dirname(tasksPath)
  const hiveKey = normalizeWatchPath(hiveDir, platform)
  const tasksKey = normalizeWatchPath(tasksPath, platform)
  return (path) => {
    const pathKey = normalizeWatchPath(path, platform)
    if (pathKey === hiveKey || pathKey === tasksKey) return false
    return pathKey.startsWith(`${hiveKey}/`) || pathKey.startsWith(`${hiveKey}\\`)
  }
}

export const buildTasksWatcherOptions = (
  workspacePath: string,
  platform: NodeJS.Platform = process.platform
): ChokidarOptions => ({
  ...TASKS_WATCHER_OPTIONS,
  ignored: createTasksWatcherIgnored(workspacePath, platform),
  ...(platform === 'win32' || isWindowsUncPath(workspacePath, platform)
    ? { interval: 500, usePolling: true }
    : {}),
})

export const getTasksWatcherReadyTimeoutMs = (
  workspacePath: string,
  platform: NodeJS.Platform = process.platform
): number =>
  platform === 'win32' || isWindowsUncPath(workspacePath, platform)
    ? WINDOWS_WATCHER_READY_TIMEOUT_MS
    : DEFAULT_WATCHER_READY_TIMEOUT_MS

const closeWatcherWithTimeout = async (watcher: FSWatcher | undefined) => {
  if (!watcher) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      watcher.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WATCHER_CLOSE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const isTasksFileEvent = (
  tasksPath: string,
  changedPath: string | Buffer | undefined,
  platform: NodeJS.Platform = process.platform
): boolean => {
  if (!changedPath) return true
  const text = Buffer.isBuffer(changedPath) ? changedPath.toString() : changedPath
  if (platform === 'win32') {
    return (
      normalize(text).toLowerCase() === normalize(tasksPath).toLowerCase() ||
      basename(text).toLowerCase() === TASKS_FILE_NAME
    )
  }
  return normalize(text) === normalize(tasksPath) || basename(text) === TASKS_FILE_NAME
}

export interface TasksFileWatcher {
  close: () => Promise<void>
  start: (workspaceId: string, workspacePath: string) => Promise<void>
  stop: (workspaceId: string) => Promise<void>
}

export const createTasksFileWatcher = ({
  onTasksUpdated,
}: {
  onTasksUpdated: (workspaceId: string, content: string) => void
}): TasksFileWatcher => {
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false

  const logWatcherError = (workspaceId: string, error: unknown) => {
    console.error(`[hive] tasks watcher error for workspace ${workspaceId}`, error)
  }

  const clearTimer = (workspaceId: string) => {
    const timer = timers.get(workspaceId)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(workspaceId)
  }

  const clearRetryTimer = (workspaceId: string) => {
    const timer = retryTimers.get(workspaceId)
    if (!timer) return
    clearTimeout(timer)
    retryTimers.delete(workspaceId)
  }

  const emitCurrentContent = async (workspaceId: string, workspacePath: string) => {
    const tasksPath = getTasksFilePath(workspacePath)
    try {
      const content = existsSync(tasksPath) ? await readFile(tasksPath, 'utf8') : ''
      onTasksUpdated(workspaceId, content)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        logWatcherError(workspaceId, error)
        return
      }
      onTasksUpdated(workspaceId, '')
    }
  }

  const stop = async (workspaceId: string) => {
    clearTimer(workspaceId)
    clearRetryTimer(workspaceId)
    const watcher = watchers.get(workspaceId)
    watchers.delete(workspaceId)
    await closeWatcherWithTimeout(watcher)
  }

  const scheduleRetry = (workspaceId: string, workspacePath: string) => {
    if (closed || retryTimers.has(workspaceId)) return
    const timer = setTimeout(() => {
      retryTimers.delete(workspaceId)
      void start(workspaceId, workspacePath).catch((error) => logWatcherError(workspaceId, error))
    }, WATCHER_RETRY_MS)
    timer.unref?.()
    retryTimers.set(workspaceId, timer)
  }

  const waitForReady = async (watcher: FSWatcher, timeoutMs: number) =>
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        watcher.off('ready', handleReady)
        watcher.off('error', handleError)
        clearTimeout(timeout)
      }
      const handleReady = () => {
        cleanup()
        resolve()
      }
      const handleError = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for tasks watcher ready after ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref?.()
      watcher.once('ready', handleReady)
      watcher.once('error', handleError)
    })

  const start = async (workspaceId: string, workspacePath: string) => {
    if (closed) return
    await stop(workspaceId)
    if (closed) return
    ensureTasksFile(workspacePath)
    if (closed) return
    const tasksPath = getTasksFilePath(workspacePath)
    const watcher = chokidar.watch(dirname(tasksPath), buildTasksWatcherOptions(workspacePath))
    const readyTimeoutMs = getTasksWatcherReadyTimeoutMs(workspacePath)
    const scheduleEmit = (changedPath?: string | Buffer) => {
      if (closed || !isTasksFileEvent(tasksPath, changedPath)) return
      clearTimer(workspaceId)
      timers.set(
        workspaceId,
        setTimeout(() => {
          timers.delete(workspaceId)
          void emitCurrentContent(workspaceId, workspacePath)
        }, DEBOUNCE_MS)
      )
    }
    watcher.on('add', scheduleEmit)
    watcher.on('change', scheduleEmit)
    watcher.on('unlink', scheduleEmit)
    watcher.on('error', (error) => {
      logWatcherError(workspaceId, error)
      void stop(workspaceId)
        .catch((closeError) => logWatcherError(workspaceId, closeError))
        .finally(() => scheduleRetry(workspaceId, workspacePath))
    })
    watchers.set(workspaceId, watcher)
    try {
      await waitForReady(watcher, readyTimeoutMs)
    } catch (error) {
      watchers.delete(workspaceId)
      await closeWatcherWithTimeout(watcher)
      scheduleRetry(workspaceId, workspacePath)
      throw error
    }
    if (closed) {
      await stop(workspaceId)
    }
  }

  return {
    close: async () => {
      closed = true
      for (const workspaceId of retryTimers.keys()) clearRetryTimer(workspaceId)
      await Promise.all(Array.from(watchers.keys(), (workspaceId) => stop(workspaceId)))
    },
    start,
    stop,
  }
}
