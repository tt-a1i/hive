import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createPostStartInputWriter } from './post-start-input-writer.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

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
        createPostStartInputWriter(agentManager, config.command)(run.runId, text)
      } else {
        agentManager?.writeInput(run.runId, text)
      }
    } catch (error) {
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      status: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      const lines = [`[Hive 系统消息：来自 @${workerName} 的汇报，状态: ${status}]`, text]
      for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
      lines.push('')
      writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, lines.join('\n'), input)
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        [
          `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
          '',
          `你的角色：${workerDescription}`,
          '',
          '你必须遵守：',
          '- 完成任务后，执行 `team report "<结论>" --success`',
          '- 失败请 `team report "<原因>" --failed`',
          '- 不要做无关的事，做完就 report',
          '',
          '任务内容：',
          text,
          '',
        ].join('\n'),
        { requireActiveRun: true }
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, `${text}\n`)
    },
  }
}
