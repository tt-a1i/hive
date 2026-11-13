import type {
  AgentSummary,
  TeamListItem,
  WorkerRole,
  WorkerSpawnSource,
  WorkspaceSummary,
} from '../shared/types.js'

export interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

export interface WorkerInput {
  avatar?: string | null
  description?: string
  name: string
  role: WorkerRole
  ephemeral?: boolean
  spawnedBy?: WorkerSpawnSource
}

export interface WorkspaceStore {
  addWorker: (workspaceId: string, input: WorkerInput, deferPublish?: boolean) => AgentSummary
  publishWorker: (workspaceId: string, worker: AgentSummary) => void
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => void
  deleteWorkspaceData: (workspaceId: string) => void
  forgetWorkspace: (workspaceId: string) => void
  deleteWorker: (workspaceId: string, workerId: string) => void
  updateWorkerProfile: (
    workspaceId: string,
    workerId: string,
    input: { avatar?: string | null; name?: string }
  ) => AgentSummary
  updateWorkerAvatar: (workspaceId: string, workerId: string, avatar: string | null) => AgentSummary
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getWorkerByName: (workspaceId: string, workerName: string) => AgentSummary
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  hasAgent: (workspaceId: string, agentId: string) => boolean
  hasWorkspace: (workspaceId: string) => boolean
  listWorkers: (workspaceId: string) => TeamListItem[]
  listWorkspaces: () => WorkspaceSummary[]
  markAgentStarted: (workspaceId: string, agentId: string) => void
  markAgentStopped: (workspaceId: string, agentId: string) => void
  markTaskDispatched: (workspaceId: string, workerId: string) => void
  markTaskCancelled: (workspaceId: string, workerId: string) => void
  markTaskReported: (workspaceId: string, workerId: string) => void
}
