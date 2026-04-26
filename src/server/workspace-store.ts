import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import type { AgentSummary } from '../shared/types.js'
import { ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'
import type { WorkerInput, WorkspaceRecord, WorkspaceStore } from './workspace-store-contract.js'
import { hydrateWorkspaceFromDb, seedWorkspacesFromDb } from './workspace-store-hydration.js'
import {
  getAgentRecord,
  getWorkerByNameRecord,
  getWorkerRecord,
  markAgentStarted,
  markAgentStopped,
  markTaskDispatched,
  markTaskReported,
} from './workspace-store-mutations.js'
import {
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

export type { WorkerInput, WorkspaceRecord, WorkspaceStore }

export const createWorkspaceStore = (
  db: Database | undefined,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()
  seedWorkspacesFromDb(db, workspaces, messageKinds)

  const getWorkspace = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
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
    deleteWorker(workspaceId, workerId) {
      const workspace = getWorkspace(workspaceId)
      getWorkerRecord(workspaces, workspaceId, workerId)
      db?.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ? AND worker_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(workerId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?').run(
          workspaceId,
          workerId
        )
      })()
      workspace.agents = workspace.agents.filter((agent) => agent.id !== workerId)
    },
    getAgent: (workspaceId, agentId) => getAgentRecord(workspaces, workspaceId, agentId),
    getWorker: (workspaceId, workerId) => getWorkerRecord(workspaces, workspaceId, workerId),
    getWorkerByName: (workspaceId, workerName) =>
      getWorkerByNameRecord(workspaces, workspaceId, workerName),
    getWorkspaceSnapshot: getWorkspace,
    hasAgent(workspaceId, agentId) {
      return getWorkspace(workspaceId).agents.some((agent) => agent.id === agentId)
    },
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
    markAgentStarted: (workspaceId, agentId) => markAgentStarted(workspaces, workspaceId, agentId),
    markAgentStopped: (workspaceId, agentId) => markAgentStopped(workspaces, workspaceId, agentId),
    markTaskDispatched: (workspaceId, workerId) =>
      markTaskDispatched(workspaces, workspaceId, workerId),
    markTaskReported: (workspaceId, workerId) =>
      markTaskReported(workspaces, workspaceId, workerId),
  }
}
