import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface TasksFileService {
  readTasks: (workspacePath: string) => string
  writeTasks: (workspacePath: string, content: string) => void
}

const getTasksFilePath = (workspacePath: string) => join(workspacePath, 'tasks.md')

const ensureWorkspaceDir = (workspacePath: string) => {
  mkdirSync(workspacePath, { recursive: true })
}

export const createTasksFileService = (): TasksFileService => {
  return {
    readTasks(workspacePath) {
      ensureWorkspaceDir(workspacePath)
      const tasksFilePath = getTasksFilePath(workspacePath)

      if (!existsSync(tasksFilePath)) {
        writeFileSync(tasksFilePath, '', 'utf8')
        return ''
      }

      return readFileSync(tasksFilePath, 'utf8')
    },

    writeTasks(workspacePath, content) {
      ensureWorkspaceDir(workspacePath)
      writeFileSync(getTasksFilePath(workspacePath), content, 'utf8')
    },
  }
}

export type { TasksFileService }
