import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'

const STARTUP_CONFIGURATION_FAILURE_MARKERS = [
  'Cannot open external editor',
  'Missing optional dependency',
  'failed to parse hooks config',
]

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

export const isRecoverableStartupConfigurationFailure = (output: string) =>
  STARTUP_CONFIGURATION_FAILURE_MARKERS.some((marker) => output.includes(marker))

export const shouldClearResumedSessionAfterExit = ({
  exitCode,
  output,
  resumedSessionId,
}: {
  exitCode: number | null
  output: string
  resumedSessionId: string | null | undefined
}) => {
  if (exitCode === 0 || !resumedSessionId) return false
  return !isRecoverableStartupConfigurationFailure(output)
}

const getRunOutput = (
  context: Pick<AgentRunExitContext, 'getRunOutput'>,
  runId: string,
  fallbackOutput: string
) => {
  try {
    return context.getRunOutput?.(runId) ?? fallbackOutput
  } catch {
    return fallbackOutput
  }
}

const clearResumedSessionOnFailure = (
  context: Pick<AgentRunExitContext, 'agentId' | 'sessionStore' | 'startConfig' | 'workspace'>,
  exitCode: number | null,
  output: string
) => {
  if (
    shouldClearResumedSessionAfterExit({
      exitCode,
      output,
      resumedSessionId: context.startConfig.resumedSessionId,
    })
  ) {
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
  const output = getRunOutput(context, runId, liveRun.output)
  clearResumedSessionOnFailure(context, exitCode, output)
  context.handledRunExits.add(runId)
  context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
  context.onAgentExit(context.workspace.id, context.agentId)
  context.registry.resolveExit(runId)
  context.registry.clearPendingExitCode(runId)
  return true
}
