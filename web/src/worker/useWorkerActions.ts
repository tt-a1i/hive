import { useCallback } from 'react'

import type { TeamListItem, WorkerRole } from '../../../src/shared/types.js'
import { createWorker, deleteWorker, startAgentRun, stopAgentRun } from '../api.js'

const upsertWorker = (workers: TeamListItem[], worker: TeamListItem): TeamListItem[] => {
  const existingIndex = workers.findIndex((item) => item.id === worker.id)
  if (existingIndex === -1) return [...workers, worker]
  return workers.map((item) => (item.id === worker.id ? worker : item))
}

interface UseWorkerActionsInput {
  activeWorkspaceId: string | null
  onWorkerDeleted?: (workspaceId: string, workerId: string) => void
  onWorkerRunStarted?: (input: {
    agentId: string
    agentName: string
    runId: string
    workspaceId: string
  }) => void
  setWorkersByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TeamListItem[]>>>
}

export interface WorkerActions {
  createWorker: (
    workerName: string,
    workerRole: WorkerRole,
    commandPresetId: string,
    roleDescription: string
  ) => Promise<{ error: string | null; runId: string | null }>
  deleteWorker: (workerId: string) => Promise<void>
  startWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  stopWorkerRun: (runId: string) => Promise<{ error: string | null }>
}

export const useWorkerActions = ({
  activeWorkspaceId,
  onWorkerDeleted,
  onWorkerRunStarted,
  setWorkersByWorkspaceId,
}: UseWorkerActionsInput): WorkerActions => {
  const createWorkerAction = useCallback<WorkerActions['createWorker']>(
    async (workerName, workerRole, commandPresetId, roleDescription) => {
      if (!activeWorkspaceId) return { error: 'No active workspace', runId: null }
      const result = await createWorker(activeWorkspaceId, {
        autostart: true,
        command_preset_id: commandPresetId,
        description: roleDescription.trim(),
        name: workerName,
        role: workerRole,
      })
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: upsertWorker(current[activeWorkspaceId] ?? [], result.worker),
      }))
      if (result.agentStart.ok && result.agentStart.runId) {
        onWorkerRunStarted?.({
          agentId: result.worker.id,
          agentName: result.worker.name,
          runId: result.agentStart.runId,
          workspaceId: activeWorkspaceId,
        })
      }
      return {
        error: result.agentStart.ok ? null : result.agentStart.error,
        runId: result.agentStart.ok ? result.agentStart.runId : null,
      }
    },
    [activeWorkspaceId, onWorkerRunStarted, setWorkersByWorkspaceId]
  )

  const deleteWorkerAction = useCallback<WorkerActions['deleteWorker']>(
    async (workerId) => {
      if (!activeWorkspaceId) throw new Error('No active workspace')
      await deleteWorker(activeWorkspaceId, workerId)
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: (current[activeWorkspaceId] ?? []).filter(
          (worker) => worker.id !== workerId
        ),
      }))
      onWorkerDeleted?.(activeWorkspaceId, workerId)
    },
    [activeWorkspaceId, onWorkerDeleted, setWorkersByWorkspaceId]
  )

  const startWorkerAction = useCallback<WorkerActions['startWorker']>(
    async (workerId) => {
      if (!activeWorkspaceId) return { error: 'No active workspace', runId: null }
      try {
        const result = await startAgentRun(activeWorkspaceId, workerId)
        onWorkerRunStarted?.({
          agentId: workerId,
          agentName: workerId,
          runId: result.runId,
          workspaceId: activeWorkspaceId,
        })
        // No optimistic status patch: server is authoritative (working iff
        // pending>0). Next listWorkers tick (≤500ms) reconciles. Optimistic
        // 'idle' would lie when worker had pending dispatches.
        return { error: null, runId: result.runId }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          runId: null,
        }
      }
    },
    [activeWorkspaceId, onWorkerRunStarted]
  )

  const stopWorkerRunAction = useCallback<WorkerActions['stopWorkerRun']>(async (runId) => {
    try {
      await stopAgentRun(runId)
      return { error: null }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [])

  return {
    createWorker: createWorkerAction,
    deleteWorker: deleteWorkerAction,
    startWorker: startWorkerAction,
    stopWorkerRun: stopWorkerRunAction,
  }
}
