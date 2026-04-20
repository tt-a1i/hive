import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

const clearResumedSessionOnFailure = (
  context: Pick<AgentRunExitContext, 'agentId' | 'sessionStore' | 'startConfig' | 'workspace'>,
  exitCode: number | null
) => {
  if (exitCode !== 0 && context.startConfig.resumedSessionId) {
    context.sessionStore.clearLastSessionId(context.workspace.id, context.agentId)
  }
}

export const handleAgentRunExit = (
  context: AgentRunExitContext,
  { exitCode, endedAt, runId }: HandleRunExitInput
) => {
  context.registry.setPendingExitCode(runId, exitCode)
  const liveRun = context.registry.get(runId)
  if (!liveRun) {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    return false
  }
  if (context.handledRunExits.has(runId)) {
    context.registry.clearPendingExitCode(runId)
    return false
  }

  completeLiveRun(liveRun, exitCode, endedAt, context.store)
  clearResumedSessionOnFailure(context, exitCode)
  context.handledRunExits.add(runId)
  context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
  context.onAgentExit(context.workspace.id, context.agentId)
  context.registry.resolveExit(runId)
  context.registry.clearPendingExitCode(runId)
  return true
}
