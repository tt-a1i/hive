import type { WorkspaceSummary } from '../shared/types.js'
import { shouldClearResumedSessionOnExit } from './agent-exit-classification.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import { getCapturedSessionExistence, type SessionCaptureSnapshot } from './session-capture.js'

interface ResumedSessionCleanupInput {
  agentId: string
  exitCode: number | null
  sessionCaptureDiscriminator?: SessionCaptureSnapshot['discriminator']
  sessionStore: AgentSessionStorePort
  startConfig: Pick<AgentLaunchConfigInput, 'cwd' | 'resumedSessionId' | 'sessionIdCapture'>
  workspace: WorkspaceSummary
}

export const shouldClearResumedSessionAfterExit = ({
  exitCode,
  sessionCaptureDiscriminator,
  startConfig,
  workspace,
}: Omit<ResumedSessionCleanupInput, 'agentId' | 'sessionStore'>) => {
  if (!shouldClearResumedSessionOnExit(exitCode)) return false
  const resumedSessionId = startConfig.resumedSessionId
  if (!resumedSessionId) return false
  const capture = startConfig.sessionIdCapture
  if (!capture) return true
  const capturedSessionExists = getCapturedSessionExistence(
    startConfig.cwd?.trim() ? startConfig.cwd : workspace.path,
    capture,
    resumedSessionId,
    sessionCaptureDiscriminator
  )
  if (capturedSessionExists === undefined) return false
  return !capturedSessionExists
}

export const clearResumedSessionAfterExitIfStale = (input: ResumedSessionCleanupInput) => {
  if (!shouldClearResumedSessionAfterExit(input)) return false
  if (
    input.sessionStore.getLastSessionId(input.workspace.id, input.agentId) !==
    input.startConfig.resumedSessionId
  ) {
    return false
  }
  input.sessionStore.clearLastSessionId(input.workspace.id, input.agentId)
  return true
}
