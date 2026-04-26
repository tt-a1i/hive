import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'

type PersistedRunStatus = PersistedAgentRun['status']

export interface AgentRunStorePort {
  close?: () => void
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
  deleteLaunchConfig: (workspaceId: string, agentId: string) => void
  saveLaunchConfig: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
}

export interface AgentSessionStorePort {
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}
