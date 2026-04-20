import type { AgentSummary, TeamListItem, WorkerRole, WorkspaceSummary } from '../shared/types.js'

export interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

export interface WorkerInput {
  description?: string
  name: string
  role: WorkerRole
}

export interface WorkspaceStore {
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getWorkerByName: (workspaceId: string, workerName: string) => AgentSummary
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  listWorkers: (workspaceId: string) => TeamListItem[]
  listWorkspaces: () => WorkspaceSummary[]
  markAgentStarted: (workspaceId: string, agentId: string) => void
  markAgentStopped: (workspaceId: string, agentId: string) => void
  markTaskDispatched: (workspaceId: string, workerId: string) => void
  markTaskReported: (workspaceId: string, workerId: string) => void
}
