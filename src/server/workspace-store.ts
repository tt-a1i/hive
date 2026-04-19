import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AgentSummary, TeamListItem, WorkerRole, WorkspaceSummary } from '../shared/types.js'
import { ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'
import {
  hydrateWorkspaceFromDb,
  seedWorkspacesFromDb,
  type WorkspaceRecord,
} from './workspace-store-hydration.js'
import {
  createOrchestrator,
  getStatusFromPendingCount,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

interface WorkerInput {
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

export type { WorkerInput, WorkspaceRecord }

export const createWorkspaceStore = (
  db: Database | undefined,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()

  const loadWorkspaceFromDb = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
  }

  const getWorkspace = (workspaceId: string) => {
    loadWorkspaceFromDb(workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`)
    }
    return workspace
  }

  const getAgent = (workspaceId: string, agentId: string) => {
    const agent = getWorkspace(workspaceId).agents.find((item) => item.id === agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    return agent
  }

  const getWorker = (workspaceId: string, workerId: string) => {
    const worker = getAgent(workspaceId, workerId)
    if (!isWorkerAgent(worker)) {
      throw new Error(`Worker not found: ${workerId}`)
    }
    return worker
  }

  const getWorkerByName = (workspaceId: string, workerName: string) => {
    const worker = getWorkspace(workspaceId).agents.find(
      (item) => item.name === workerName && isWorkerAgent(item)
    )
    if (!worker) {
      throw new Error(`Worker not found: ${workerName}`)
    }
    return worker
  }

  const setPendingCount = (workspaceId: string, workerId: string, pendingTaskCount: number) => {
    const worker = getWorker(workspaceId, workerId)
    worker.pendingTaskCount = pendingTaskCount
    worker.status = getStatusFromPendingCount(pendingTaskCount)
  }

  seedWorkspacesFromDb(db, workspaces, messageKinds)

  return {
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      if (workspace.agents.some((agent) => agent.name === input.name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${input.name}`)
      }

      const worker: AgentSummary = {
        id: randomUUID(),
        workspaceId,
        name: input.name,
        description: input.description ?? getDefaultRoleDescription(input.role),
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
      }
      db?.prepare(
        'INSERT INTO workers (id, workspace_id, name, description, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(worker.id, workspaceId, worker.name, worker.description, worker.role, Date.now())
      workspace.agents.push(worker)
      return worker
    },
    createWorkspace(path, name) {
      const summary = { id: randomUUID(), name, path }
      db?.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        summary.id,
        name,
        path,
        Date.now()
      )
      workspaces.set(summary.id, { summary, agents: [createOrchestrator(summary.id)] })
      return summary
    },
    getAgent,
    getWorker,
    getWorkerByName,
    getWorkspaceSnapshot: getWorkspace,
    listWorkers(workspaceId) {
      return getWorkspace(workspaceId)
        .agents.filter(isWorkerAgent)
        .map(({ id, name, role, status, pendingTaskCount }) => ({
          id,
          name,
          role,
          status,
          pendingTaskCount,
        }))
    },
    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },
    markAgentStarted(workspaceId, agentId) {
      const agent = getAgent(workspaceId, agentId)
      agent.status = getStatusFromPendingCount(agent.pendingTaskCount)
    },
    markAgentStopped(workspaceId, agentId) {
      getAgent(workspaceId, agentId).status = 'stopped'
    },
    markTaskDispatched(workspaceId, workerId) {
      const worker = getWorker(workspaceId, workerId)
      setPendingCount(workspaceId, workerId, worker.pendingTaskCount + 1)
    },
    markTaskReported(workspaceId, workerId) {
      const worker = getWorker(workspaceId, workerId)
      const pendingTaskCount = Math.max(0, worker.pendingTaskCount - 1)
      worker.pendingTaskCount = pendingTaskCount
      if (worker.status !== 'stopped') {
        worker.status = getStatusFromPendingCount(pendingTaskCount)
      }
    },
  }
}
