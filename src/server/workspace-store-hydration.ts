import type { Database } from 'better-sqlite3'
import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import { getDefaultRoleDescription } from './role-templates.js'
import {
  applyPendingTaskCount,
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
  type WorkerRow,
  type WorkspaceRow,
  type WorkspaceSummaryRow,
} from './workspace-store-support.js'

export interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

const createWorkerSummary = (
  workspaceId: string,
  row: Pick<WorkerRow, 'description' | 'id' | 'name' | 'role'>
): AgentSummary => ({
  id: row.id,
  workspaceId,
  name: row.name,
  description: row.description ?? getDefaultRoleDescription(row.role),
  role: row.role,
  status: 'stopped',
  pendingTaskCount: 0,
})

const applyMessageKinds = (
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[],
  workspaceId?: string
) => {
  for (const row of messageKinds) {
    if (workspaceId && row.workspace_id !== workspaceId) {
      continue
    }

    const worker = workspaces
      .get(row.workspace_id)
      ?.agents.find((agent) => agent.id === row.worker_id)
    if (!worker || !isWorkerAgent(worker)) {
      continue
    }

    applyPendingTaskCount(worker, row.type, true)
  }
}

export const hydrateWorkspaceFromDb = (
  db: Database | undefined,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[],
  workspaceId: string
) => {
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
    workspaces.get(workspaceId)?.agents.push(createWorkerSummary(workerRow.workspace_id, workerRow))
  }

  applyMessageKinds(workspaces, messageKinds, workspaceId)
}

export const seedWorkspacesFromDb = (
  db: Database | undefined,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[]
) => {
  if (!db) {
    return
  }

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
    workspaces.get(row.workspace_id)?.agents.push(createWorkerSummary(row.workspace_id, row))
  }

  applyMessageKinds(workspaces, messageKinds)
}
