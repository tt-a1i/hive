import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { ActiveDiscussionInfo, ActiveDispatchInfo } from './recovery-summary.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

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
  activeDispatches,
  activeDiscussions,
  agent,
  tasksContent,
  workers,
  workspace,
  restartWindowMessages,
}: {
  activeDispatches?: ActiveDispatchInfo[]
  activeDiscussions?: ActiveDiscussionInfo[]
  agent: AgentSummary
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  restartWindowMessages: RecoveryMessage[]
}) => {
  const lines: string[] = [
    '你刚被 Hive 重启了。期间环境变化：',
    `- 当前 workspace: ${workspace.name}`,
    '- 现有 worker:',
    ...formatWorkers(workers),
    `- ${TASKS_RELATIVE_PATH} 当前内容:`,
    tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)',
    '- 任务纪律: 派单前先建 task（编辑 tasks.md 或 --create-task）；新需求立即记录；worker report 后及时勾选完成',
  ]

  if (activeDispatches && activeDispatches.length > 0) {
    lines.push('- 活跃派单:')
    for (const d of activeDispatches.slice(0, 5)) {
      lines.push(`  - @${d.toWorkerName} [${d.status}]: ${d.text.slice(0, 60)}`)
    }
  }

  if (activeDiscussions && activeDiscussions.length > 0) {
    lines.push('- 进行中讨论:')
    for (const d of activeDiscussions.slice(0, 3)) {
      lines.push(`  - "${d.topic}" (${d.status}, round ${d.currentRound}/${d.maxRounds})`)
    }
  }

  lines.push(
    ...formatRestartWindow(restartWindowMessages),
    agent.role === 'orchestrator' ? '- Hive worker 派单规则:' : '- Hive worker 边界:',
    ...getHiveTeamRules(agent).map((rule) => `  - ${rule}`),
    `请继续。如果不确定，用 team list / Read ${TASKS_RELATIVE_PATH} 自查或问 user。`,
  )

  return wrapSystemMessage(lines.join('\n'))
}
