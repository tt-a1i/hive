import type { WorkspaceSummary } from '../shared/types.js'

import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { SendPromptWrite } from './agent-stdin-dispatcher.js'
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
  findLiveRun: (runId: string) => LiveAgentRun | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  waitForRunExit: (runId: string, timeoutMs: number) => Promise<boolean>
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
  switchAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    config: import('./agent-run-store.js').AgentLaunchConfigInput,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  validateAgentToken: AgentTokenRegistry['validate']
  writeStatusPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean }
  ) => Promise<void>
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    fromAgentName: string,
    workerDescription: string,
    text: string,
    requiredSeenSeq?: number,
    input?: { beforeWrite?: () => boolean }
  ) => SendPromptWrite
  writeCancelPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    reason: string,
    input?: { requireActiveRun?: boolean }
  ) => Promise<void>
  writeUserInputPrompt: (workspaceId: string, text: string) => void
  writeSystemMessageToAgent: (workspaceId: string, agentId: string, text: string) => void
  deliverUserInputToOrchestrator: (
    workspaceId: string,
    text: string,
    input?: { requireActiveRun?: boolean }
  ) => Promise<void>
  /** Awaitable opaque delivery — used to drain the report outbox so an entry
   *  is marked delivered only after the PTY write resolves. */
  deliverSystemMessageToAgent: (
    workspaceId: string,
    agentId: string,
    text: string,
    input?: { requireActiveRun?: boolean; beforeWrite?: () => boolean }
  ) => Promise<void>
}

export type { StartAgentOptions }
