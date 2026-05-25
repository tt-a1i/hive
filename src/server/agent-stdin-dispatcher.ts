import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { buildWorkerReminderTail, ORCHESTRATOR_REMINDER_TAIL } from './hive-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createOrchMessageQueue, type MessagePriority } from './orch-message-queue.js'
import { createPostStartInputWriter, hasInteractivePromptReady } from './post-start-input-writer.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的汇报]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的状态更新]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (text: string): string =>
  [text, '', ORCHESTRATOR_REMINDER_TAIL, ''].join('\n')

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  workerDescription: string,
  dispatchId: string,
  text: string
): string =>
  [
    `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
    '',
    `你的角色：${workerDescription}`,
    '',
    '你必须遵守：',
    `- 完成、失败、阻塞或部分完成后，执行 \`team report "<result>" --dispatch ${dispatchId}\``,
    '- 不要做无关的事，做完就 report',
    '',
    `dispatch_id: ${dispatchId}`,
    '',
    '任务内容：',
    text,
    '',
    buildWorkerReminderTail(dispatchId),
    '',
  ].join('\n')

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `[Hive 系统消息：dispatch ${dispatchId} 已取消]`,
    '',
    '请停止执行这条派单，不要再为它调用 team report。',
    '',
    '取消原因：',
    reason,
    '',
  ].join('\n')

export const isOperationalAlert = (text: string): boolean =>
    /^\[(STOPPED|CRASHED|FAILED|ERROR|EXPIRED|UNREACHABLE)\]/im.test(text)

export const isFailedReport = (text: string): boolean =>
    /^\[(FAILED|BLOCKED|ERROR)\]/im.test(text)

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
}: AgentStdinDispatcherInput) => {
  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ) => {
    const run = registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        createPostStartInputWriter(agentManager, config.interactiveCommand ?? config.command)(
          run.runId,
          text
        )
      } else {
        agentManager?.writeInput(run.runId, text)
      }
    } catch (error) {
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  const orchQueue = createOrchMessageQueue((workspaceId, messages) => {
    for (const text of messages) {
      try {
        writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, text)
      } catch {
        // Orch not active — messages are lost only if PTY is gone
      }
    }
  })

  const flushQueueThenWrite = (workspaceId: string, text: string) => {
    writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, text)
    const queued = orchQueue.flush(workspaceId)
    for (const msg of queued) {
      try {
        writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, msg)
      } catch {
        // best-effort flush
      }
    }
  }

  const isOrchestratorBusy = (workspaceId: string): boolean => {
    const orchId = `${workspaceId}:orchestrator`
    const run = registry
      .list()
      .filter((item) => item.agentId === orchId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })
    if (!run || !agentManager) return false
    try {
      const liveRun = agentManager.getRun(run.runId)
      if (!liveRun.output) return true
      const config = getLaunchConfig(workspaceId, orchId)
      const command = config?.interactiveCommand ?? config?.command ?? ''
      return !hasInteractivePromptReady(liveRun.output, command)
    } catch {
      return false
    }
  }

  const enqueueOrInject = (
    workspaceId: string,
    text: string,
    input: { requireActiveRun?: boolean; priority?: MessagePriority } = {}
  ) => {
    const priority = input.priority ?? 'normal'
    if (priority === 'high' || isOrchestratorBusy(workspaceId)) {
      // High priority or Orch busy (not at prompt) — inject immediately
      writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, text, input)
    } else {
      // Orch is at prompt (user might be typing) — queue with batch window
      orchQueue.enqueue(workspaceId, text, priority)
    }
  }

  return {
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      _workerId: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      const priority: MessagePriority = isFailedReport(text) ? 'high' : 'normal'
      enqueueOrInject(
        workspaceId,
        buildOrchestratorReportPayload(workerName, text, artifacts),
        { ...input, priority }
      )
    },
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      _workerId: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      if (!isOperationalAlert(text)) return
      enqueueOrInject(
        workspaceId,
        buildOrchestratorStatusPayload(workerName, text, artifacts),
        { ...input, priority: 'high' }
      )
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerDispatchPayload(fromAgentName, workerDescription, dispatchId, text),
        { requireActiveRun: true }
      )
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason),
        input
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      flushQueueThenWrite(workspaceId, buildOrchestratorUserInputPayload(text))
    },
    writeToAgent(workspaceId: string, agentId: string, text: string) {
      writeToActiveAgentRun(workspaceId, agentId, text, { requireActiveRun: true })
    },
    dispose() {
      orchQueue.dispose()
    },
  }
}
