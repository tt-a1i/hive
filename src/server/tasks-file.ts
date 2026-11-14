import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

interface TasksFileService {
  readTasks: (workspacePath: string) => string
  writeTasks: (workspacePath: string, content: string) => void
}

export const HIVE_DIR_NAME = '.hive'
export const TASKS_FILE_NAME = 'tasks.md'
export const TASKS_RELATIVE_PATH = `${HIVE_DIR_NAME}/${TASKS_FILE_NAME}`

export const getTasksFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, TASKS_FILE_NAME)

const getLegacyTasksFilePath = (workspacePath: string) => join(workspacePath, TASKS_FILE_NAME)
const RETRYABLE_TASKS_FS_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const TASKS_FS_RETRY_DELAYS_MS = [20, 50, 100]

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const runRetryableTasksFileOperation = <T>(operation: () => T): T => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      const delay = TASKS_FS_RETRY_DELAYS_MS[attempt]
      if (!code || !RETRYABLE_TASKS_FS_ERROR_CODES.has(code) || delay === undefined) throw error
      sleepSync(delay)
    }
  }
}

const ensureTasksDir = (workspacePath: string) => {
  runRetryableTasksFileOperation(() =>
    mkdirSync(dirname(getTasksFilePath(workspacePath)), { recursive: true })
  )
}

const writeUtf8FileAtomically = (targetPath: string, content: string) => {
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`)
  let committed = false
  let fd: number | null = null
  try {
    try {
      fd = openSync(tempPath, 'w')
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally {
      if (fd !== null) {
        closeSync(fd)
        fd = null
      }
    }
    renameSync(tempPath, targetPath)
    committed = true
  } finally {
    if (!committed && existsSync(tempPath)) rmSync(tempPath, { force: true })
  }
}

export const ensureTasksFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const tasksFilePath = getTasksFilePath(workspacePath)
  if (existsSync(tasksFilePath)) {
    return runRetryableTasksFileOperation(() => readFileSync(tasksFilePath, 'utf8'))
  }

  const legacyTasksFilePath = getLegacyTasksFilePath(workspacePath)
  const content = existsSync(legacyTasksFilePath)
    ? runRetryableTasksFileOperation(() => readFileSync(legacyTasksFilePath, 'utf8'))
    : ''
  runRetryableTasksFileOperation(() => writeUtf8FileAtomically(tasksFilePath, content))
  return content
}

export const createTasksFileService = (): TasksFileService => {
  return {
    readTasks(workspacePath) {
      return ensureTasksFile(workspacePath)
    },

    writeTasks(workspacePath, content) {
      ensureTasksDir(workspacePath)
      runRetryableTasksFileOperation(() =>
        writeUtf8FileAtomically(getTasksFilePath(workspacePath), content)
      )
    },
  }
}

export type { TasksFileService }
