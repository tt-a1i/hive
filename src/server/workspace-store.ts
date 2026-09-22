import { randomUUID } from 'node:crypto'
import type { AgentSummary } from '../shared/types.js'
import { normalizeWorkerAvatar } from '../shared/worker-avatar.js'
import { ConflictError, HttpError } from './http-errors.js'
import { sameFilesystemPath } from './path-canonicalization.js'
import { getDefaultRoleDescription } from './role-templates.js'
import type { Database } from './sqlite.js'
import type { WorkerInput, WorkspaceRecord, WorkspaceStore } from './workspace-store-contract.js'
import { hydrateWorkspaceFromDb, seedWorkspacesFromDb } from './workspace-store-hydration.js'
import {
  getAgentRecord,
  getWorkerByNameRecord,
  getWorkerRecord,
  markAgentStarted,
  markAgentStopped,
  markTaskCancelled,
  markTaskDispatched,
  markTaskReported,
} from './workspace-store-mutations.js'
import {
  createOrchestrator,
  createWorkflowAgent,
  getStatusFromPendingCount,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

export type { WorkerInput, WorkspaceRecord, WorkspaceStore }

const normalizeWorkerName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Worker name must not be empty')
  if (trimmed.length > 64) throw new Error('Worker name must be 64 characters or fewer')
  return trimmed
}

export const createWorkspaceStore = (
  db: Database,
  listOpenDispatchKindsInput: (() => MessageKindRecord[]) | MessageKindRecord[]
): WorkspaceStore => {
  const listOpenDispatchKinds =
    typeof listOpenDispatchKindsInput === 'function'
      ? listOpenDispatchKindsInput
      : () => listOpenDispatchKindsInput
  const workspaces = new Map<string, WorkspaceRecord>()
  seedWorkspacesFromDb(db, workspaces, listOpenDispatchKinds())

  const syncPendingFromDispatchLedger = (workspace: WorkspaceRecord) => {
    const counts = new Map<string, number>()
    for (const item of listOpenDispatchKinds()) {
      if (item.workspace_id !== workspace.summary.id) continue
      counts.set(item.worker_id, (counts.get(item.worker_id) ?? 0) + 1)
    }
    for (const agent of workspace.agents) {
      if (!isWorkerAgent(agent)) continue
      const pendingTaskCount = counts.get(agent.id) ?? 0
      agent.pendingTaskCount = pendingTaskCount
      if (agent.status !== 'stopped') agent.status = getStatusFromPendingCount(pendingTaskCount)
    }
  }

  const getWorkspace = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, listOpenDispatchKinds(), workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) throw new HttpError(404, `Workspace not found: ${workspaceId}`)
    syncPendingFromDispatchLedger(workspace)
    return workspace
  }

  const deleteWorkspaceData = (workspaceId: string) => {
    const workspace = getWorkspace(workspaceId)
    const agentIds = workspace.agents.map((agent) => agent.id)
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM report_outbox WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId)
      const deleteAgentRuns = db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
      for (const agentId of agentIds) deleteAgentRuns.run(agentId)
      db.prepare('DELETE FROM workers WHERE workspace_id = ?').run(workspaceId)
      // TIER 1 #4 — cascade workflow tables. Without this, the scheduler's
      // listDueSchedules keeps firing schedules for the dead workspace
      // every minute (the startWorkflow then crashes in
      // getWorkflowAgentId / addWorkerWithLaunch and `nextRunAt` is
      // rewritten to fire again next tick — a permanent error-spam
      // loop). Orphan workflow_runs / dispatches would otherwise also
      // accumulate forever. The dispatches DELETE in particular hits the
      // workflow-tagged subset; non-workflow dispatches were already
      // cleared via the deleteWorker cascade above.
      db.prepare('DELETE FROM workflow_schedules WHERE workspace_id = ?').run(workspaceId)
      // TIER 2 #3 — also wipe the log table; FK is on run_id, so we
      // have to clear it BEFORE deleting workflow_runs (the lookup
      // would otherwise miss the rows we're about to delete).
      db.prepare(
        `DELETE FROM workflow_run_logs
         WHERE run_id IN (SELECT id FROM workflow_runs WHERE workspace_id = ?)`
      ).run(workspaceId)
      db.prepare('DELETE FROM workflow_runs WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
    })()
  }

  return {
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      const name = normalizeWorkerName(input.name)
      const avatar = normalizeWorkerAvatar(input.avatar)
      if (workspace.agents.some((agent) => agent.name === name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${name}`)
      }
      const worker: AgentSummary = {
        id: randomUUID(),
        workspaceId,
        name,
        description: input.description ?? getDefaultRoleDescription(input.role),
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
        ...(avatar ? { avatar } : {}),
        ephemeral: input.ephemeral ?? false,
        spawnedBy: input.spawnedBy ?? null,
      }
      db.prepare(
        'INSERT INTO workers (id, workspace_id, name, description, role, avatar, ephemeral, spawned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        worker.id,
        workspaceId,
        worker.name,
        worker.description,
        worker.role,
        avatar,
        worker.ephemeral ? 1 : 0,
        worker.spawnedBy ?? null,
        Date.now()
      )
      workspace.agents.push(worker)
      return worker
    },
    createWorkspace(path, name, controllerMode = 'internal') {
      const existing = Array.from(workspaces.values()).find((workspace) =>
        sameFilesystemPath(workspace.summary.path, path)
      )
      if (existing) throw new ConflictError(`Workspace path already exists: ${path}`)
      const summary = {
        id: randomUUID(),
        name,
        path,
        ...(controllerMode === 'codex_app' ? { controller_mode: 'codex_app' as const } : {}),
      }
      db.prepare(
        'INSERT INTO workspaces (id, name, path, created_at, controller_mode) VALUES (?, ?, ?, ?, ?)'
      ).run(summary.id, name, path, Date.now(), controllerMode)
      workspaces.set(summary.id, {
        summary,
        agents: [createOrchestrator(summary.id), createWorkflowAgent(summary.id)],
      })
      return summary
    },
    deleteWorkspace(workspaceId) {
      deleteWorkspaceData(workspaceId)
      workspaces.delete(workspaceId)
    },
    deleteWorkspaceData,
    forgetWorkspace(workspaceId) {
      workspaces.delete(workspaceId)
    },
    renameWorker(workspaceId, workerId, name) {
      const workspace = getWorkspace(workspaceId)
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const trimmed = normalizeWorkerName(name)
      if (trimmed === worker.name) return worker
      if (
        workspace.agents.some(
          (agent) => agent.id !== workerId && agent.name === trimmed && isWorkerAgent(agent)
        )
      ) {
        throw new ConflictError(`Worker name already exists: ${trimmed}`)
      }
      db.prepare('UPDATE workers SET name = ? WHERE workspace_id = ? AND id = ?').run(
        trimmed,
        workspaceId,
        workerId
      )
      worker.name = trimmed
      return worker
    },
    updateWorkerProfile(workspaceId, workerId, input) {
      const workspace = getWorkspace(workspaceId)
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const hasName = Object.hasOwn(input, 'name')
      const hasAvatar = Object.hasOwn(input, 'avatar')
      const trimmed = hasName ? normalizeWorkerName(input.name ?? '') : undefined
      const avatar = hasAvatar ? normalizeWorkerAvatar(input.avatar) : undefined
      const nameChanged = trimmed !== undefined && trimmed !== worker.name

      if (
        nameChanged &&
        workspace.agents.some(
          (agent) => agent.id !== workerId && agent.name === trimmed && isWorkerAgent(agent)
        )
      ) {
        throw new ConflictError(`Worker name already exists: ${trimmed}`)
      }

      db.transaction(() => {
        if (nameChanged && hasAvatar) {
          db.prepare(
            'UPDATE workers SET name = ?, avatar = ? WHERE workspace_id = ? AND id = ?'
          ).run(trimmed, avatar ?? null, workspaceId, workerId)
          return
        }
        if (nameChanged) {
          db.prepare('UPDATE workers SET name = ? WHERE workspace_id = ? AND id = ?').run(
            trimmed,
            workspaceId,
            workerId
          )
          return
        }
        if (hasAvatar) {
          db.prepare('UPDATE workers SET avatar = ? WHERE workspace_id = ? AND id = ?').run(
            avatar ?? null,
            workspaceId,
            workerId
          )
        }
      })()

      if (nameChanged && trimmed !== undefined) {
        worker.name = trimmed
      }
      if (hasAvatar) {
        if (avatar) {
          worker.avatar = avatar
        } else {
          delete worker.avatar
        }
      }
      return worker
    },
    updateWorkerAvatar(workspaceId, workerId, inputAvatar) {
      getWorkspace(workspaceId)
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const avatar = normalizeWorkerAvatar(inputAvatar)
      db.prepare('UPDATE workers SET avatar = ? WHERE workspace_id = ? AND id = ?').run(
        avatar,
        workspaceId,
        workerId
      )
      if (avatar) {
        worker.avatar = avatar
      } else {
        delete worker.avatar
      }
      return worker
    },
    deleteWorker(workspaceId, workerId) {
      const workspace = getWorkspace(workspaceId)
      getWorkerRecord(workspaces, workspaceId, workerId)
      db.transaction(() => {
        // Protocol history (send/report) outlives the member: an ephemeral
        // reviewer's findings must remain in the log after it auto-dismisses.
        db.prepare(
          `DELETE FROM messages
           WHERE workspace_id = ? AND worker_id = ? AND type NOT IN ('send', 'report')`
        ).run(workspaceId, workerId)
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
    getAgent(workspaceId, agentId) {
      getWorkspace(workspaceId)
      return getAgentRecord(workspaces, workspaceId, agentId)
    },
    getWorker(workspaceId, workerId) {
      getWorkspace(workspaceId)
      return getWorkerRecord(workspaces, workspaceId, workerId)
    },
    getWorkerByName(workspaceId, workerName) {
      getWorkspace(workspaceId)
      return getWorkerByNameRecord(workspaces, workspaceId, workerName)
    },
    getWorkspaceSnapshot: getWorkspace,
    hasAgent(workspaceId, agentId) {
      hydrateWorkspaceFromDb(db, workspaces, listOpenDispatchKinds(), workspaceId)
      return workspaces.get(workspaceId)?.agents.some((agent) => agent.id === agentId) ?? false
    },
    listWorkers(workspaceId) {
      return getWorkspace(workspaceId)
        .agents.filter(isWorkerAgent)
        .map(
          ({
            avatar,
            id,
            name,
            description,
            role,
            status,
            pendingTaskCount,
            ephemeral,
            spawnedBy,
          }) => ({
            id,
            name,
            description,
            role,
            status,
            pendingTaskCount,
            ...(avatar ? { avatar } : {}),
            // Carry the lifecycle marker through to the team panel so workflow-
            // spawned ephemeral workers can be visually distinguished from the
            // user's persistent team (M10).
            ...(ephemeral === true ? { ephemeral: true as const } : {}),
            ...(spawnedBy ? { spawnedBy } : {}),
          })
        )
    },
    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },
    hasWorkspace(workspaceId: string) {
      return workspaces.has(workspaceId)
    },
    markAgentStarted: (workspaceId, agentId) => markAgentStarted(workspaces, workspaceId, agentId),
    markAgentStopped: (workspaceId, agentId) => markAgentStopped(workspaces, workspaceId, agentId),
    markTaskDispatched: (workspaceId, workerId) =>
      markTaskDispatched(workspaces, workspaceId, workerId),
    markTaskCancelled: (workspaceId, workerId) =>
      markTaskCancelled(workspaces, workspaceId, workerId),
    markTaskReported: (workspaceId, workerId) =>
      markTaskReported(workspaces, workspaceId, workerId),
  }
}
