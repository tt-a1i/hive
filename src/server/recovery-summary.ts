type AgentStatus = 'working' | 'idle' | 'stopped'

interface RecoveryWorker {
  id: string
  name: string
  role: string
  status: AgentStatus
  pendingTaskCount: number
}

interface RecoveryMessageBase {
  createdAt: number
  text: string
}

interface UserInputMessage extends RecoveryMessageBase {
  type: 'user_input'
}

interface SendMessage extends RecoveryMessageBase {
  type: 'send'
  to: string
}

interface ReportMessage extends RecoveryMessageBase {
  type: 'report'
  from: string
  status: string
}

type RecoveryMessage = UserInputMessage | SendMessage | ReportMessage

interface BuildRecoverySummaryInput {
  workspaceName: string
  agentRole: string
  tasksContent: string
  workers: RecoveryWorker[]
  messages: RecoveryMessage[]
}

const formatMessage = (message: RecoveryMessage) => {
  if (message.type === 'user_input') {
    return `- user: ${message.text}`
  }

  if (message.type === 'send') {
    return `- send -> ${message.to}: ${message.text}`
  }

  return `- report <- ${message.from} [${message.status}]: ${message.text}`
}

const formatWorker = (worker: RecoveryWorker) => {
  return `- ${worker.name} (${worker.role}, ${worker.status}) pending=${worker.pendingTaskCount}`
}

export const buildRecoverySummary = (input: BuildRecoverySummaryInput) => {
  const messages = [...input.messages]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(formatMessage)
    .join('\n')

  const workers = input.workers.map(formatWorker).join('\n')
  const tasksContent = input.tasksContent.trim() || '(empty)'

  return [
    `你是 ${input.workspaceName} 的 ${input.agentRole}`,
    '',
    '最近 1 小时与 user 的对话',
    messages,
    '',
    '当前 tasks.md 状态',
    tasksContent,
    '',
    '当前 worker 状态',
    workers,
  ].join('\n')
}

export type { BuildRecoverySummaryInput, RecoveryMessage, RecoveryWorker }
