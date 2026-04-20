import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import type { RecoveryMessage } from './message-log-store.js'
import { wrapSystemMessage } from './system-message.js'

const TASKS_HEAD_LIMIT = 1024

const formatWorkers = (workers: AgentSummary[]) => {
  if (workers.length === 0) return ['- 当前没有其他 worker']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const formatRestartWindow = (messages: RecoveryMessage[]) => {
  const sends = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' }> => {
      return message.type === 'send'
    }
  )
  if (sends.length === 0) return ['- 重启期间未派新单']
  return sends.slice(-5).map((message) => `- send -> ${message.to}: ${message.text}`)
}

export const buildEnvSyncMessage = ({
  tasksContent,
  workers,
  workspace,
  restartWindowMessages,
}: {
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  restartWindowMessages: RecoveryMessage[]
}) =>
  wrapSystemMessage(
    [
      '你刚被 Hive 重启了。期间环境变化：',
      `- 当前 workspace: ${workspace.name}`,
      '- 现有 worker:',
      ...formatWorkers(workers),
      '- tasks.md 当前内容:',
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)',
      ...formatRestartWindow(restartWindowMessages),
      '请继续。如果不确定，用 team list / Read tasks.md 自查或问 user。',
    ].join('\n')
  )
