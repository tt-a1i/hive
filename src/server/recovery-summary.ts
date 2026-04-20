import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import type { RecoveryMessage } from './message-log-store.js'
import { wrapSystemMessage } from './system-message.js'

const TASKS_HEAD_LIMIT = 1536

const formatUserInputs = (messages: RecoveryMessage[]) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs.slice(-5).map((message) => `- user: ${message.text}`)
    : ['- （最近 1 小时没有新的 user_input）']
}

const formatTaskEvents = (messages: RecoveryMessage[], agent: AgentSummary) => {
  const taskEvents = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' | 'report' }> => {
      if (agent.role === 'orchestrator') {
        if (message.type === 'send') return message.from === agent.id
        return message.type === 'report'
      }
      if (message.type === 'send') return message.to === agent.id || message.from === agent.id
      return message.type === 'report' && message.from === agent.id
    }
  )
  return taskEvents.length > 0
    ? taskEvents.slice(-8).map((message) => {
        if (message.type === 'send') return `- send -> ${message.to}: ${message.text}`
        return `- report <- ${message.from} [${message.status}]: ${message.text}`
      })
    : ['- （最近没有任务事件）']
}

const formatWorkers = (workers: AgentSummary[]) => {
  if (workers.length === 0) return ['- 当前没有其他 worker']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const getTaskSectionTitle = (agent: AgentSummary) =>
  agent.role === 'orchestrator' ? '## 你已派出的任务' : '## 最近派给你的任务'

export const buildRecoverySummary = ({
  agent,
  messages,
  tasksContent,
  workers,
  workspace,
}: {
  agent: AgentSummary
  messages: RecoveryMessage[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
}) =>
  wrapSystemMessage(
    [
      `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`,
      '你刚刚因为崩溃重启，且无法通过原生 session resume 恢复。下面是接力上下文。',
      '',
      '## 最近 1 小时与 user 的对话',
      ...formatUserInputs(messages),
      '',
      getTaskSectionTitle(agent),
      ...formatTaskEvents(messages, agent),
      '',
      '## 当前 tasks.md 状态',
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)',
      '',
      '## 当前活跃 worker',
      ...formatWorkers(workers),
      '',
      '请基于此继续。如果不确定，问 user。',
    ].join('\n')
  )
