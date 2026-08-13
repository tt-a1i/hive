import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1536

export interface ActiveDispatchInfo {
  status: string
  text: string
  toWorkerName: string
}

export interface ActiveDiscussionInfo {
  currentRound: number
  maxRounds: number
  status: string
  topic: string
}

const formatActiveDispatches = (dispatches: ActiveDispatchInfo[]) => {
  if (dispatches.length === 0) return ['- （无活跃派单）']
  return dispatches.slice(0, 5).map(
    (d) => `- @${d.toWorkerName} [${d.status}]: ${d.text.slice(0, 80)}`
  )
}

const formatActiveDiscussions = (discussions: ActiveDiscussionInfo[]) => {
  if (discussions.length === 0) return ['- （无进行中讨论）']
  return discussions.slice(0, 3).map(
    (d) => `- "${d.topic}" (${d.status}, round ${d.currentRound}/${d.maxRounds})`
  )
}

const formatUserInputs = (messages: RecoveryMessage[]) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs.slice(-5).map((message) => `- user: ${message.text}`)
    : ['- （最近 1 小时没有新的 user_input）']
}

const formatTaskEvents = (messages: RecoveryMessage[], agent: AgentSummary) => {
  const taskEvents = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' | 'report' | 'status' }> => {
      if (agent.role === 'orchestrator') {
        if (message.type === 'send') return message.from === agent.id
        return message.type === 'report' || message.type === 'status'
      }
      if (message.type === 'send') return message.to === agent.id || message.from === agent.id
      return (message.type === 'report' || message.type === 'status') && message.from === agent.id
    }
  )
  return taskEvents.length > 0
    ? taskEvents.slice(-8).map((message) => {
        if (message.type === 'send') return `- send -> ${message.to}: ${message.text}`
        if (message.type === 'status') return `- status <- ${message.from}: ${message.text}`
        const status = message.status ? ` [${message.status}]` : ''
        return `- report <- ${message.from}${status}: ${message.text}`
      })
    : ['- （最近没有任务事件）']
}

const getOpenTaskTargets = (agent: AgentSummary, workers: AgentSummary[]) =>
  agent.role === 'orchestrator' ? workers : [agent]

const formatOpenTasks = (
  messages: RecoveryMessage[],
  agent: AgentSummary,
  workers: AgentSummary[]
) => {
  const targetAgents = getOpenTaskTargets(agent, workers).filter(
    (target) => target.role !== 'orchestrator'
  )
  const targetIds = new Set(targetAgents.map((target) => target.id))
  const queues = new Map<string, Array<Extract<RecoveryMessage, { type: 'send' }>>>()

  for (const message of messages) {
    if (message.type === 'send' && targetIds.has(message.to)) {
      const queue = queues.get(message.to) ?? []
      queue.push(message)
      queues.set(message.to, queue)
      continue
    }

    if (message.type === 'report' && targetIds.has(message.from)) {
      queues.get(message.from)?.shift()
    }
  }

  const lines: string[] = []
  for (const target of targetAgents) {
    const queue = queues.get(target.id) ?? []
    for (const task of queue.slice(-8)) {
      lines.push(`- ${target.name}: ${task.text}`)
    }
    if (target.pendingTaskCount > queue.length) {
      lines.push(
        `- ${target.name}: ${target.pendingTaskCount - queue.length} 个 pending 无可恢复详情`
      )
    }
  }

  return lines.length > 0 ? lines : ['- （当前没有未完成任务）']
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
  activeDispatches,
  activeDiscussions,
  agent,
  allTaskMessages,
  checkpoint,
  messages,
  tasksContent,
  workers,
  workspace,
}: {
  activeDispatches?: ActiveDispatchInfo[]
  activeDiscussions?: ActiveDiscussionInfo[]
  agent: AgentSummary
  allTaskMessages?: RecoveryMessage[]
  checkpoint?: string | null
  messages: RecoveryMessage[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
}) => {
  const sections: string[] = [
    `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`,
    '你刚被 Hive 重启了，且无法通过原生 session resume 恢复。下面是接力上下文。',
  ]

  if (checkpoint) {
    sections.push('', '## 你上次进度', checkpoint)
  }

  sections.push(
    '',
    '## 最近 1 小时与 user 的对话',
    ...formatUserInputs(messages),
    '',
    getTaskSectionTitle(agent),
    ...formatTaskEvents(messages, agent),
    '',
    '## 当前未完成任务',
    ...formatOpenTasks(allTaskMessages ?? messages, agent, workers),
  )

  if (activeDispatches && activeDispatches.length > 0) {
    sections.push('', '## 活跃派单', ...formatActiveDispatches(activeDispatches))
  }

  if (activeDiscussions && activeDiscussions.length > 0) {
    sections.push('', '## 进行中讨论', ...formatActiveDiscussions(activeDiscussions))
  }

  sections.push(
    '',
    `## 当前 ${TASKS_RELATIVE_PATH} 状态`,
    tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)',
    '',
    '## 任务纪律',
    '- 派单前先建 task：执行 `team send` 前，确保 tasks.md 中有对应条目（手动编辑或 `team send --create-task`）',
    '- 新需求立即记录：讨论/review/用户指示产生新工作时，第一时间写入 tasks.md',
    '- 完成即勾选：worker report 后及时标记对应 task 完成（编辑 tasks.md 勾选 checkbox）',
    '- 不要只在对话中提到任务而不写入 tasks.md',
    '',
    '## 当前活跃 worker',
    ...formatWorkers(workers),
    '',
    agent.role === 'orchestrator' ? '## Hive worker 派单规则' : '## Hive worker 边界',
    ...getHiveTeamRules(agent),
    '',
    '请基于此继续。如果不确定，问 user。',
  )

  return wrapSystemMessage(sections.join('\n'))
}
