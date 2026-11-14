import type { AgentSummary, WorkerSpawnSource } from '../shared/types.js'
import { getDefaultRoleDescription } from './role-templates.js'
import type { Database } from './sqlite.js'
import type { WorkspaceRecord } from './workspace-store-contract.js'
import {
  applyPendingTaskCount,
  createOrchestrator,
  createWorkflowAgent,
  getOrchestratorId,
  isWorkerAgent,
  type MessageKindRecord,
  type WorkerRow,
  type WorkspaceRow,
} from './workspace-store-support.js'

const createWorkerSummary = (
  workspaceId: string,
  row: Pick<WorkerRow, 'description' | 'id' | 'name' | 'role'> &
    Partial<Pick<WorkerRow, 'avatar' | 'ephemeral' | 'spawned_by'>>
): AgentSummary => ({
  id: row.id,
  workspaceId,
  name: row.name,
  description: row.description ?? getDefaultRoleDescription(row.role),
  role: row.role,
  status: 'stopped',
  pendingTaskCount: 0,
  ...(row.avatar ? { avatar: row.avatar } : {}),
  ephemeral: row.ephemeral === 1,
  spawnedBy: (row.spawned_by as WorkerSpawnSource | null | undefined) ?? null,
})

/**
 * Build the worker SELECT defensively. The global runtime data dir
 * (`~/.config/hive`) is shared across every Hive install on the machine, so a
 * DB may have been migrated forward by a NEWER Hive whose `schema_version`
 * already lists 19+. In that case our own v19 ALTER is skipped and the
 * `workers` table can lack `ephemeral`/`spawned_by`. Selecting a non-existent
 * column throws and crashes startup, so we only request the optional columns
 * when they actually exist; `createWorkerSummary` defaults them otherwise.
 */
const buildWorkerSelect = (db: Database, whereClause: string): string => {
  const present = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map((c) => c.name)
  )
  const optional = ['avatar', 'ephemeral', 'spawned_by'].filter((column) => present.has(column))
  const columns = ['id', 'workspace_id', 'name', 'description', 'role', ...optional].join(', ')
  const where = whereClause ? `${whereClause} ` : ''
  return `SELECT ${columns} FROM workers ${where}ORDER BY created_at ASC`
}

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
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[],
  workspaceId: string
) => {
  if (workspaces.has(workspaceId)) {
    return
  }

  const row = db.prepare('SELECT id, name, path FROM workspaces WHERE id = ?').get(workspaceId) as
    | WorkspaceRow
    | undefined
  if (!row) {
    return
  }

  workspaces.set(row.id, {
    summary: {
      id: row.id,
      name: row.name,
      path: row.path,
    },
    agents: [createOrchestrator(row.id), createWorkflowAgent(row.id)],
  })

  for (const workerRow of db
    .prepare(buildWorkerSelect(db, 'WHERE workspace_id = ?'))
    .all(workspaceId) as WorkerRow[]) {
    if (workerRow.id !== getOrchestratorId(workspaceId))
      workspaces
        .get(workspaceId)
        ?.agents.push(createWorkerSummary(workerRow.workspace_id, workerRow))
  }

  applyMessageKinds(workspaces, messageKinds, workspaceId)
}

export const seedWorkspacesFromDb = (
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[]
) => {
  for (const row of db
    .prepare('SELECT id, name, path FROM workspaces ORDER BY created_at ASC')
    .all() as WorkspaceRow[]) {
    workspaces.set(row.id, {
      summary: {
        id: row.id,
        name: row.name,
        path: row.path,
      },
      agents: [createOrchestrator(row.id), createWorkflowAgent(row.id)],
    })
  }

  for (const row of db.prepare(buildWorkerSelect(db, '')).all() as WorkerRow[]) {
    if (row.id !== getOrchestratorId(row.workspace_id))
      workspaces.get(row.workspace_id)?.agents.push(createWorkerSummary(row.workspace_id, row))
  }

  applyMessageKinds(workspaces, messageKinds)
}
