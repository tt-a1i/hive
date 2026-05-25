import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { injectAnchor } from './task-anchor.js'
import { getTasksFilePath } from './tasks-file.js'

const NEXT_ACTIONS_HEADING = /^##\s+\d+\.\s*Next Actions/i
const LIST_ITEM = /^(?:[-*]\s+|\d+\.\s+)(.+)/

export const parseNextActions = (reportText: string): string[] => {
  const lines = reportText.split('\n')
  let inSection = false
  const actions: string[] = []

  for (const line of lines) {
    if (NEXT_ACTIONS_HEADING.test(line)) {
      inSection = true
      continue
    }
    if (inSection && line.startsWith('## ')) break
    if (inSection) {
      const m = LIST_ITEM.exec(line)
      if (m?.[1]) {
        const text = m[1].trim()
        if (text.length > 0) actions.push(text)
      }
    }
  }

  return actions
}

export interface TaskService {
  createTask(input: {
    workspaceId: string
    title: string
    source: 'discussion'
    sourceRef?: string
  }): { id: string; seq: number }
}

export const appendActionsToTasks = (
  workspacePath: string,
  topic: string,
  actions: string[],
  taskService?: TaskService,
  workspaceId?: string,
  groupId?: string
): number => {
  if (actions.length === 0) return 0

  const tasksPath = getTasksFilePath(workspacePath)
  const dir = dirname(tasksPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const header = `\n\n## 讨论产出：${topic}\n\n`
  let items = actions.map((a) => `- [ ] ${a}`).join('\n')

  if (taskService && workspaceId) {
    const lines = items.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const title = line.replace(/^- \[[ x]\]\s*/, '').trim()
      const task = taskService.createTask({
        workspaceId,
        title,
        source: 'discussion',
        ...(groupId ? { sourceRef: groupId } : {}),
      })
      const taskId = task.id
      lines[i] = `- [ ] #${task.seq} ${title}`
      items = lines.join('\n')
      items = injectAnchor(items, i, taskId)
    }
  }

  appendFileSync(tasksPath, `${header}${items}\n`, 'utf8')
  return actions.length
}
