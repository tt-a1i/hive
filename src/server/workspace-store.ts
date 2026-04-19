import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  AgentStatus,
  AgentSummary,
  TeamListItem,
  WorkerRole,
  WorkspaceSummary,
} from '../shared/types.js'
import { ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'

interface WorkerInput {
  description?: string
  name: string
  role: WorkerRole
}

interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

interface MessageKindRecord {
  type: 'send' | 'report'
  worker_id: string
  workspace_id: string
}

interface WorkspaceRow {
  id: string
  name: string
  path: string
}

interface WorkerRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  role: WorkerRole
}

interface WorkspaceSummaryRow extends WorkspaceRow {}

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

export const getOrchestratorId = (workspaceId: string) => `${workspaceId}:orchestrator`

const createOrchestrator = (workspaceId: string): AgentSummary => ({
  id: getOrchestratorId(workspaceId),
  workspaceId,
  name: 'Orchestrator',
  description: getDefaultRoleDescription('orchestrator'),
  role: 'orchestrator',
  status: 'idle',
  pendingTaskCount: 0,
})

const isWorkerAgent = (agent: AgentSummary): agent is AgentSummary & { role: WorkerRole } => {
  return agent.role !== 'orchestrator'
}

const getStatusFromPendingCount = (pendingTaskCount: number): AgentStatus => {
  return pendingTaskCount > 0 ? 'working' : 'idle'
}

const applyPendingTaskCount = (
  worker: AgentSummary & { role: WorkerRole },
  type: MessageKindRecord['type'],
  preserveStoppedStatus: boolean
) => {
  worker.pendingTaskCount =
    type === 'send' ? worker.pendingTaskCount + 1 : Math.max(0, worker.pendingTaskCount - 1)
  if (!preserveStoppedStatus) {
    worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
  }
}

export const createWorkspaceStore = (
  db: Database | undefined,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()

  const loadWorkspaceFromDb = (workspaceId: string) => {
    if (!db || workspaces.has(workspaceId)) {
      return
    }

    const row = db.prepare('SELECT id, name, path FROM workspaces WHERE id = ?').get(workspaceId) as
      | WorkspaceSummaryRow
      | undefined
    if (!row) {
      return
    }

    workspaces.set(row.id, {
      summary: { id: row.id, name: row.name, path: row.path },
      agents: [createOrchestrator(row.id)],
    })

    for (const workerRow of db
      .prepare(
        'SELECT id, workspace_id, name, description, role FROM workers WHERE workspace_id = ? ORDER BY created_at ASC'
      )
      .all(workspaceId) as WorkerRow[]) {
      workspaces.get(workspaceId)?.agents.push({
        id: workerRow.id,
        workspaceId: workerRow.workspace_id,
        name: workerRow.name,
        description: workerRow.description ?? getDefaultRoleDescription(workerRow.role),
        role: workerRow.role,
        status: 'stopped',
        pendingTaskCount: 0,
      })
    }

    for (const row of messageKinds) {
      if (row.workspace_id !== workspaceId) {
        continue
      }

      const worker = workspaces.get(workspaceId)?.agents.find((agent) => agent.id === row.worker_id)
      if (!worker || !isWorkerAgent(worker)) {
        continue
      }
      applyPendingTaskCount(worker, row.type, true)
    }
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

  if (db) {
    for (const row of db
      .prepare('SELECT id, name, path FROM workspaces ORDER BY created_at ASC')
      .all() as WorkspaceRow[]) {
      workspaces.set(row.id, {
        summary: { id: row.id, name: row.name, path: row.path },
        agents: [createOrchestrator(row.id)],
      })
    }

    for (const row of db
      .prepare(
        'SELECT id, workspace_id, name, description, role FROM workers ORDER BY created_at ASC'
      )
      .all() as WorkerRow[]) {
      const workspace = workspaces.get(row.workspace_id)
      workspace?.agents.push({
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description ?? getDefaultRoleDescription(row.role),
        role: row.role,
        status: 'stopped',
        pendingTaskCount: 0,
      })
    }
  }

  for (const row of messageKinds) {
    const workspace = workspaces.get(row.workspace_id)
    const worker = workspace?.agents.find((agent) => agent.id === row.worker_id)
    if (!worker || !isWorkerAgent(worker)) {
      continue
    }
    applyPendingTaskCount(worker, row.type, true)
  }

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
        status: 'idle',
        pendingTaskCount: 0,
      }
      workspace.agents.push(worker)
      db?.prepare(
        'INSERT INTO workers (id, workspace_id, name, description, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(worker.id, workspaceId, worker.name, worker.description, worker.role, Date.now())
      return worker
    },
    createWorkspace(path, name) {
      const summary = { id: randomUUID(), name, path }
      workspaces.set(summary.id, { summary, agents: [createOrchestrator(summary.id)] })
      db?.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        summary.id,
        name,
        path,
        Date.now()
      )
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
      setPendingCount(workspaceId, workerId, Math.max(0, worker.pendingTaskCount - 1))
    },
  }
}
