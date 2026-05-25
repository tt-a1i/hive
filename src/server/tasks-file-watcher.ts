import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import chokidar, { type FSWatcher } from 'chokidar'

import { ensureProtocolFile, ensureTasksFile, getTasksFilePath } from './tasks-file.js'

const DEBOUNCE_MS = 100
const TASK_LINE_RE = /^(\s*)-\s+\[( |x|X)\]\s+(.*)$/
const SEQ_PREFIX_RE = /^#(\d+)\s+/

export interface ParsedTaskLine {
  checked: boolean
  indent: number
  seq: number | null
  title: string
}

export const parseTaskLines = (content: string): ParsedTaskLine[] => {
  const results: ParsedTaskLine[] = []
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(TASK_LINE_RE)
    if (!m) continue
    const indent = (m[1] ?? '').replace(/\t/g, '  ').length
    const checked = (m[2] ?? ' ').toLowerCase() === 'x'
    let text = m[3] ?? ''
    let seq: number | null = null
    const seqMatch = text.match(SEQ_PREFIX_RE)
    if (seqMatch) {
      seq = Number(seqMatch[1])
      text = text.slice(seqMatch[0].length)
    }
    results.push({ checked, indent, seq, title: text.trim() })
  }
  return results
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

  const clearTimer = (workspaceId: string) => {
    const timer = timers.get(workspaceId)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(workspaceId)
  }

  const emitCurrentContent = async (workspaceId: string, workspacePath: string) => {
    const tasksPath = getTasksFilePath(workspacePath)
    try {
      const content = existsSync(tasksPath) ? await readFile(tasksPath, 'utf8') : ''
      onTasksUpdated(workspaceId, content)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      onTasksUpdated(workspaceId, '')
    }
  }

  const stop = async (workspaceId: string) => {
    clearTimer(workspaceId)
    const watcher = watchers.get(workspaceId)
    watchers.delete(workspaceId)
    await watcher?.close()
  }

  return {
    close: async () => {
      await Promise.all(Array.from(watchers.keys(), (workspaceId) => stop(workspaceId)))
    },
    start: async (workspaceId, workspacePath) => {
      await stop(workspaceId)
      ensureTasksFile(workspacePath)
      ensureProtocolFile(workspacePath)
      const watcher = chokidar.watch(getTasksFilePath(workspacePath), {
        ignoreInitial: true,
      })
      const scheduleEmit = () => {
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
      watchers.set(workspaceId, watcher)
      await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
    },
    stop,
  }
}
