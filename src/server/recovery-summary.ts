import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import type { DispatchRecord } from './dispatch-ledger-store.js'
import { buildDispatchQuestionReplyCommand } from './dispatch-message-reply.js'
import { FEATURE_FLAGS_ALL_OFF, type FeatureFlags } from './feature-flags.js'
import { escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapRawSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1536

const formatUserInputs = (messages: RecoveryMessage[]) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs.slice(-5).map((message) => `- user: ${escapeHiveEnvelopeText(message.text)}`)
    : ['- (no new user_input in the last hour)']
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
        if (message.type === 'send') {
          return `- send -> ${escapeHiveEnvelopeText(message.to)}: ${escapeHiveEnvelopeText(message.text)}`
        }
        if (message.type === 'status') {
          return `- status <- ${escapeHiveEnvelopeText(message.from)}: ${escapeHiveEnvelopeText(message.text)}`
        }
        const status = message.status ? ` [${message.status}]` : ''
        return `- report <- ${escapeHiveEnvelopeText(message.from)}${status}: ${escapeHiveEnvelopeText(message.text)}`
      })
    : ['- (no recent task events)']
}

const formatOpenTasks = (dispatches: DispatchRecord[] | undefined, agent: AgentSummary) => {
  if (!dispatches) return ['- Ledger unavailable; inspect `team list` before acting.']
  const open = dispatches.filter(
    (dispatch) =>
      (dispatch.status === 'queued' || dispatch.status === 'submitted') &&
      (agent.role === 'orchestrator' || dispatch.toAgentId === agent.id)
  )
  if (open.length === 0) return ['- (no open tasks right now)']
  return open.map(
    (dispatch) =>
      `- dispatch ${dispatch.id} (${dispatch.status}, owner ${escapeHiveEnvelopeText(dispatch.toAgentId)}): ${escapeHiveEnvelopeText(dispatch.text)}`
  )
}

const formatDispatchMessages = (
  dispatches: DispatchRecord[] | undefined,
  messages: DispatchMessageRecord[],
  agent: AgentSummary
) => {
  const open = (dispatches ?? []).filter(
    (dispatch) =>
      (dispatch.status === 'queued' || dispatch.status === 'submitted') &&
      (agent.role === 'orchestrator' || dispatch.toAgentId === agent.id)
  )
  return open.flatMap((dispatch) => {
    const related = messages.filter(
      (message) => message.dispatchId === dispatch.id || message.sourceDispatchId === dispatch.id
    )
    return [
      `- dispatch ${dispatch.id}: this recovery preview may omit messages or truncate their text. Before reporting, read \`team messages --dispatch ${dispatch.id}\` in full, consider its inbound requirements, and use that inspected response's required_seen_seq. Do not acknowledge inputs from this preview alone.`,
      ...related
        .slice(-8)
        .map(
          (message) =>
            `  - ${message.id} (dispatch ${message.dispatchId}) #${message.sequence} ${message.kind} (${message.deliveryState}): ${escapeHiveEnvelopeText(message.text.slice(0, 500))}`
        ),
    ]
  })
}

const formatPendingQuestions = (messages: DispatchMessageRecord[], agent: AgentSummary) => {
  const questions = messages.filter(
    (message) => message.kind === 'question' && message.recipientAgentId === agent.id
  )
  if (questions.length === 0) return []
  return [
    '## Questions awaiting your answer (including completed responsibilities)',
    'Answer the requested context; this does not reopen completed work or authorize new implementation.',
    ...questions.flatMap((message) => {
      const replyCommand = buildDispatchQuestionReplyCommand(message)
      return [
        `- question ${message.id}: target ${message.dispatchId}; source ${message.sourceDispatchId ?? 'orchestrator'}; from ${escapeHiveEnvelopeText(message.fromAgentId)}; ${message.deliveryState}.`,
        `  ${escapeHiveEnvelopeText(message.text.slice(0, 1000))}`,
        `  Read: team messages --dispatch ${message.dispatchId}`,
        ...(replyCommand ? [`  Reply with your answer on stdin: ${replyCommand}`] : []),
      ]
    }),
  ]
}

const formatWorkers = (workers: AgentSummary[]) => {
  if (workers.length === 0) return ['- (no other members)']
  return workers.map(
    (worker) =>
      `- ${escapeHiveEnvelopeText(worker.name)} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const getTaskSectionTitle = (agent: AgentSummary) =>
  agent.role === 'orchestrator' ? '## Tasks you dispatched' : '## Tasks recently sent to you'

export const buildRecoverySummary = ({
  agent,
  openDispatches,
  dispatchMessages = [],
  actionableDispatchMessages = [],
  resumedSession = false,
  memoryDigest,
  messages,
  tasksContent,
  workers,
  workspace,
  flags = FEATURE_FLAGS_ALL_OFF,
}: {
  agent: AgentSummary
  allTaskMessages?: RecoveryMessage[]
  openDispatches?: DispatchRecord[]
  dispatchMessages?: DispatchMessageRecord[]
  actionableDispatchMessages?: DispatchMessageRecord[]
  resumedSession?: boolean
  memoryDigest?: string | null | undefined
  messages: RecoveryMessage[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  /** Live experimental flags — keep the recovered handover prompt consistent
   *  with what a fresh startup would inject (workflow + team-sizing rules). */
  flags?: FeatureFlags
}) =>
  wrapRawSystemMessage(
    [
      `You are ${escapeHiveEnvelopeText(agent.name)} (${agent.role}) in workspace ${escapeHiveEnvelopeText(workspace.name)}.`,
      `Current member profile: ${escapeHiveEnvelopeText(agent.description)}`,
      resumedSession
        ? 'Your native session resumed. These are current protocol facts; PTY delivery is not proof that inputs were considered.'
        : 'Hive restarted you. These are current responsibility facts; verify artifacts before continuing work.',
      '',
      '## Conversation with the user in the last hour',
      ...formatUserInputs(messages),
      '',
      getTaskSectionTitle(agent),
      ...formatTaskEvents(messages, agent),
      '',
      '## Open tasks (dispatch ledger)',
      ...formatOpenTasks(openDispatches, agent),
      ...formatDispatchMessages(openDispatches, dispatchMessages, agent),
      ...formatPendingQuestions(actionableDispatchMessages, agent),
      '',
      `## Current ${TASKS_RELATIVE_PATH}`,
      escapeHiveEnvelopeText(tasksContent.slice(0, TASKS_HEAD_LIMIT)) || '(empty)',
      '',
      '## Active members',
      ...formatWorkers(workers),
      '',
      ...(memoryDigest ? ['## Hive memory digest', memoryDigest, ''] : []),
      agent.role === 'orchestrator' ? '## Hive member dispatch rules' : '## Hive member boundaries',
      ...getHiveTeamRules(agent, flags),
      '',
      'Continue from these facts within your current responsibility; reconcile missing context before acting.',
    ].join('\n')
  )
