import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import type { TeamListItem, WorkerRole } from '../../../src/shared/types.js'
import {
  createWorker,
  deleteWorker,
  restartAgentRun,
  startAgentRun,
  stopAgentRun,
  type TerminalInputProfile,
  updateWorkerAvatar,
} from '../api.js'
import { useI18n } from '../i18n.js'

const upsertWorker = (workers: TeamListItem[], worker: TeamListItem): TeamListItem[] => {
  const existingIndex = workers.findIndex((item) => item.id === worker.id)
  if (existingIndex === -1) return [...workers, worker]
  return workers.map((item) => (item.id === worker.id ? worker : item))
}

const getTerminalInputProfileForPreset = (
  commandPresetId: string | null | undefined
): TerminalInputProfile => {
  if (commandPresetId === 'claude') return 'claude'
  if (commandPresetId === 'codex') return 'codex'
  if (commandPresetId === 'grok') return 'grok'
  return commandPresetId === 'opencode' ? 'opencode' : 'default'
}

const getWorkerTerminalInputProfile = (
  workers: TeamListItem[],
  workerId: string
): TerminalInputProfile =>
  getTerminalInputProfileForPreset(
    workers.find((worker) => worker.id === workerId)?.commandPresetId
  )

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface UseWorkerActionsInput {
  activeWorkspaceId: string | null
  onWorkerDeleted?: (workspaceId: string, workerId: string) => void
  onWorkerStartFailed?: (message: string) => void
  onWorkerRunStarted?: (input: {
    agentId: string
    agentName: string
    runId: string
    terminalInputProfile?: TerminalInputProfile
    workspaceId: string
  }) => void
  onWorkerRunClosed?: (workspaceId: string, runId: string) => void
  setWorkersByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TeamListItem[]>>>
  workers: TeamListItem[]
}

export interface CreateWorkerActionInput {
  avatar?: string | null
  commandPresetId: string
  name: string
  role: WorkerRole
  roleDescription: string
  startupCommand: string
}

export interface WorkerActions {
  createWorker: (input: CreateWorkerActionInput) => Promise<{
    error: string | null
    runId: string | null
  }>
  deleteWorker: (workerId: string) => Promise<void>
  updateWorkerAvatar: (workerId: string, avatar: string | null) => Promise<{ error: string | null }>
  startWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  stopWorkerRun: (runId: string) => Promise<{ error: string | null }>
  restartWorkerRun: (
    workerId: string,
    runId: string
  ) => Promise<{ error: string | null; runId: string | null }>
}

export const useWorkerActions = ({
  activeWorkspaceId,
  onWorkerDeleted,
  onWorkerStartFailed,
  onWorkerRunStarted,
  onWorkerRunClosed,
  setWorkersByWorkspaceId,
  workers,
}: UseWorkerActionsInput): WorkerActions => {
  const scope = useMemo(() => ({ activeWorkspaceId }), [activeWorkspaceId])
  const currentScope = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const { language } = useI18n()
  const createWorkerAction = useCallback<WorkerActions['createWorker']>(
    async ({ avatar, commandPresetId, name, role, roleDescription, startupCommand }) => {
      if (!activeWorkspaceId) return { error: 'No active workspace', runId: null }
      const startupClean = startupCommand.trim()
      const result = await createWorker(activeWorkspaceId, {
        autostart: false,
        avatar: avatar ?? null,
        command_preset_id: commandPresetId || null,
        description: roleDescription.trim(),
        name,
        role,
        startup_command: startupClean || null,
        ui_language: language,
      }).catch((error) => {
        if (currentScope.current !== scope) return null
        throw error
      })
      if (!result) return { error: null, runId: null }
      if (currentScope.current === scope)
        setWorkersByWorkspaceId((current) => ({
          ...current,
          [activeWorkspaceId]: upsertWorker(current[activeWorkspaceId] ?? [], {
            ...result.worker,
            status: 'idle',
          }),
        }))
      const workspaceId = activeWorkspaceId
      void startAgentRun(workspaceId, result.worker.id)
        .then((startResult) => {
          if (currentScope.current !== scope) return
          onWorkerRunStarted?.({
            agentId: result.worker.id,
            agentName: result.worker.name,
            runId: startResult.runId,
            terminalInputProfile: getTerminalInputProfileForPreset(commandPresetId),
            workspaceId,
          })
        })
        .catch((error) => {
          if (currentScope.current !== scope) return
          const message = errorMessage(error)
          console.error('[hive] swallowed:createWorker.start', error)
          setWorkersByWorkspaceId((current) => ({
            ...current,
            [workspaceId]: upsertWorker(current[workspaceId] ?? [], {
              ...result.worker,
              status: 'stopped',
            }),
          }))
          onWorkerStartFailed?.(message)
        })
      return { error: null, runId: null }
    },
    [
      activeWorkspaceId,
      language,
      onWorkerRunStarted,
      onWorkerStartFailed,
      setWorkersByWorkspaceId,
      scope,
    ]
  )

  const deleteWorkerAction = useCallback<WorkerActions['deleteWorker']>(
    async (workerId) => {
      if (!activeWorkspaceId) throw new Error('No active workspace')
      try {
        await deleteWorker(activeWorkspaceId, workerId)
      } catch (error) {
        if (currentScope.current !== scope) return
        throw error
      }
      if (currentScope.current !== scope) return
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: (current[activeWorkspaceId] ?? []).filter(
          (worker) => worker.id !== workerId
        ),
      }))
      onWorkerDeleted?.(activeWorkspaceId, workerId)
    },
    [activeWorkspaceId, onWorkerDeleted, setWorkersByWorkspaceId, scope]
  )

  const updateWorkerAvatarAction = useCallback<WorkerActions['updateWorkerAvatar']>(
    async (workerId, avatar) => {
      if (!activeWorkspaceId) return { error: 'No active workspace' }
      try {
        const worker = await updateWorkerAvatar(activeWorkspaceId, workerId, avatar)
        if (currentScope.current !== scope) return { error: null }
        setWorkersByWorkspaceId((current) => ({
          ...current,
          [activeWorkspaceId]: upsertWorker(current[activeWorkspaceId] ?? [], worker),
        }))
        return { error: null }
      } catch (error) {
        if (currentScope.current !== scope) return { error: null }
        return { error: errorMessage(error) }
      }
    },
    [activeWorkspaceId, setWorkersByWorkspaceId, scope]
  )

  const startWorkerAction = useCallback<WorkerActions['startWorker']>(
    async (workerId) => {
      if (!activeWorkspaceId) return { error: 'No active workspace', runId: null }
      try {
        const result = await startAgentRun(activeWorkspaceId, workerId)
        if (currentScope.current !== scope) return { error: null, runId: null }
        onWorkerRunStarted?.({
          agentId: workerId,
          agentName: workers.find((worker) => worker.id === workerId)?.name ?? workerId,
          runId: result.runId,
          terminalInputProfile: getWorkerTerminalInputProfile(workers, workerId),
          workspaceId: activeWorkspaceId,
        })
        // No optimistic status patch: server is authoritative (working iff
        // pending>0). Next listWorkers tick (≤500ms) reconciles. Optimistic
        // 'idle' would lie when worker had pending dispatches.
        return { error: null, runId: result.runId }
      } catch (error) {
        if (currentScope.current !== scope) return { error: null, runId: null }
        return {
          error: errorMessage(error),
          runId: null,
        }
      }
    },
    [activeWorkspaceId, onWorkerRunStarted, workers, scope]
  )

  const stopWorkerRunAction = useCallback<WorkerActions['stopWorkerRun']>(
    async (runId) => {
      if (!activeWorkspaceId) return { error: 'No active workspace' }
      try {
        await stopAgentRun(runId)
        if (currentScope.current !== scope) return { error: null }
        onWorkerRunClosed?.(activeWorkspaceId, runId)
        return { error: null }
      } catch (error) {
        if (currentScope.current !== scope) return { error: null }
        return { error: errorMessage(error) }
      }
    },
    [activeWorkspaceId, onWorkerRunClosed, scope]
  )

  const restartWorkerRunAction = useCallback<WorkerActions['restartWorkerRun']>(
    async (workerId, runId) => {
      if (!activeWorkspaceId) return { error: 'No active workspace', runId: null }
      try {
        const result = await restartAgentRun(activeWorkspaceId, workerId, runId)
        if (currentScope.current !== scope) return { error: null, runId: null }
        onWorkerRunClosed?.(activeWorkspaceId, runId)
        onWorkerRunStarted?.({
          agentId: workerId,
          agentName: workers.find((worker) => worker.id === workerId)?.name ?? workerId,
          runId: result.runId,
          terminalInputProfile: getWorkerTerminalInputProfile(workers, workerId),
          workspaceId: activeWorkspaceId,
        })
        return { error: null, runId: result.runId }
      } catch (error) {
        if (currentScope.current !== scope) return { error: null, runId: null }
        return {
          error: errorMessage(error),
          runId: null,
        }
      }
    },
    [activeWorkspaceId, onWorkerRunClosed, onWorkerRunStarted, workers, scope]
  )

  return {
    createWorker: createWorkerAction,
    deleteWorker: deleteWorkerAction,
    updateWorkerAvatar: updateWorkerAvatarAction,
    startWorker: startWorkerAction,
    stopWorkerRun: stopWorkerRunAction,
    restartWorkerRun: restartWorkerRunAction,
  }
}
