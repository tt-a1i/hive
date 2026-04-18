import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import type {
  AgentStatus,
  AgentSummary,
  TeamListItem,
  WorkerRole,
  WorkspaceSummary,
} from '../shared/types.js'

interface WorkerInput {
  name: string
  role: WorkerRole
}

interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

const isWorkerAgent = (agent: AgentSummary): agent is AgentSummary & { role: WorkerRole } => {
  return agent.role !== 'orchestrator'
}

interface RuntimeStore {
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  dispatchTask: (workspaceId: string, workerId: string, _text: string) => void
  reportTask: (workspaceId: string, workerId: string) => void
  listWorkers: (workspaceId: string) => TeamListItem[]
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
}

interface RuntimeStoreOptions {
  dataDir?: string
}

interface WorkspaceRow {
  id: string
  name: string
  path: string
}

export type { RuntimeStore }

const makeId = () => Math.random().toString(36).slice(2, 10)

const createOrchestrator = (workspaceId: string): AgentSummary => ({
  id: makeId(),
  workspaceId,
  name: 'Orchestrator',
  role: 'orchestrator',
  status: 'idle',
  pendingTaskCount: 0,
})

const getStatusFromPendingCount = (pendingTaskCount: number): AgentStatus => {
  return pendingTaskCount > 0 ? 'working' : 'idle'
}

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const workspaces = new Map<string, WorkspaceRecord>()
  const db = options.dataDir
    ? (() => {
        mkdirSync(options.dataDir, { recursive: true })
        const database = new Database(join(options.dataDir, 'runtime.sqlite'))
        database.exec(`
          CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `)
        return database
      })()
    : undefined

  if (db) {
    const rows = db
      .prepare('SELECT id, name, path FROM workspaces ORDER BY created_at ASC')
      .all() as WorkspaceRow[]

    for (const row of rows) {
      workspaces.set(row.id, {
        summary: {
          id: row.id,
          name: row.name,
          path: row.path,
        },
        agents: [createOrchestrator(row.id)],
      })
    }
  }

  const getWorkspaceRecord = (workspaceId: string) => {
    const workspace = workspaces.get(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`)
    }

    return workspace
  }

  const getWorkerRecord = (workspaceId: string, workerId: string) => {
    const workspace = getWorkspaceRecord(workspaceId)
    const worker = workspace.agents.find((agent) => agent.id === workerId)

    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`)
    }

    return worker
  }

  return {
    createWorkspace(path, name) {
      const workspaceId = makeId()
      const summary: WorkspaceSummary = {
        id: workspaceId,
        name,
        path,
      }

      const orchestrator = createOrchestrator(workspaceId)

      workspaces.set(workspaceId, {
        summary,
        agents: [orchestrator],
      })

      db?.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        workspaceId,
        name,
        path,
        Date.now()
      )

      return summary
    },

    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },

    addWorker(workspaceId, input) {
      const workspace = getWorkspaceRecord(workspaceId)
      const worker: AgentSummary = {
        id: makeId(),
        workspaceId,
        name: input.name,
        role: input.role,
        status: 'idle',
        pendingTaskCount: 0,
      }

      workspace.agents.push(worker)
      return worker
    },

    dispatchTask(workspaceId, workerId, _text) {
      const worker = getWorkerRecord(workspaceId, workerId)
      worker.pendingTaskCount += 1
      worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
    },

    reportTask(workspaceId, workerId) {
      const worker = getWorkerRecord(workspaceId, workerId)
      worker.pendingTaskCount = 0
      worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
    },

    listWorkers(workspaceId) {
      return getWorkspaceRecord(workspaceId)
        .agents.filter(isWorkerAgent)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.status,
          pendingTaskCount: agent.pendingTaskCount,
        }))
    },

    getWorkspaceSnapshot(workspaceId) {
      return getWorkspaceRecord(workspaceId)
    },

    getWorker(workspaceId, workerId) {
      return getWorkerRecord(workspaceId, workerId)
    },
  }
}
