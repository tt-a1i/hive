import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'

type PersistedRunStatus = PersistedAgentRun['status']

export interface AgentRunStorePort {
  initialize?: () => void
  insertAgentRun: (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status?: PersistedRunStatus,
    exitCode?: number | null,
    endedAt?: number | null
  ) => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listLaunchConfigs: () => Array<{
    agentId: string
    config: AgentLaunchConfigInput
    workspaceId: string
  }>
  saveLaunchConfig: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
}

export interface AgentSessionStorePort {
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}
