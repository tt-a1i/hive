import type { WorkspaceSummary } from '../shared/types.js'

import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface StartAgentOptions {
  hivePort: string
}

export interface AgentRuntime {
  close: () => Promise<void>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: import('./agent-run-store.js').AgentLaunchConfigInput
  ) => void
  deleteAgentLaunchConfig: (workspaceId: string, agentId: string) => void
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => import('./agent-run-store.js').AgentLaunchConfigInput | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  getPtyOutputBus: () => PtyOutputBus
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  pauseRun: (runId: string) => void
  peekAgentToken: (agentId: string) => string | undefined
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  stopAgentRun: (runId: string) => void
  validateAgentToken: AgentTokenRegistry['validate']
  writeReportPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean }
  ) => void
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    fromAgentName: string,
    workerDescription: string,
    text: string
  ) => void
  writeUserInputPrompt: (workspaceId: string, text: string) => void
}

export type { StartAgentOptions }
