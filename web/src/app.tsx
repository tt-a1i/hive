import { useEffect, useRef, useState } from 'react'

import type { WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { createWorker, deleteWorker, saveActiveWorkspaceId, startAgentRun } from './api.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'

const RUNTIME_ADDRESS = '127.0.0.1:4010'
const HIVE_PORT = '4010'

const upsertWorker = <T extends { id: string }>(workers: T[], worker: T): T[] => {
  const existingIndex = workers.findIndex((item) => item.id === worker.id)
  if (existingIndex === -1) return [...workers, worker]
  return workers.map((item) => (item.id === worker.id ? worker : item))
}

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(activeWorkspaceId)
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(true)
  const activeWorkspaceSaveQueue = useRef(Promise.resolve())

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

  const selectWorkspace = (workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId)
    activeWorkspaceSaveQueue.current = activeWorkspaceSaveQueue.current
      .catch(() => {})
      .then(() => saveActiveWorkspaceId(workspaceId))
      .catch(() => {})
  }

  const { orchestratorAutostartErrors, recordOrchestratorResult, createNewWorkspace } =
    useWorkspaceCreate({
      hivePort: HIVE_PORT,
      onWorkspaceCreated: (workspace) => {
        setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
        selectWorkspace(workspace.id)
        setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      },
    })

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    )
  }, [activeWorkspaceId])

  // Auto-open the picker on empty-state so the user is never stuck at a blank
  // canvas. The dialog itself fires the native OS folder picker on trigger
  // change; setting the trigger once per empty-state detection is enough.
  const emptyStateTriggeredRef = useRef(false)
  useEffect(() => {
    if (workspaces === null) return
    if (workspaces.length === 0 && !emptyStateTriggeredRef.current) {
      emptyStateTriggeredRef.current = true
      setAddDialogTrigger((value) => value + 1)
    }
  }, [workspaces])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeTasksFile = useTasksFile(activeWorkspaceId)
  const activeWorkers = activeWorkspace ? (workersByWorkspaceId[activeWorkspace.id] ?? []) : []
  const agentsAlive =
    Object.values(workersByWorkspaceId).reduce(
      (total, list) => total + list.filter((worker) => worker.status !== 'stopped').length,
      0
    ) + (activeWorkspace ? 1 : 0)

  const handleCreateWorker = async (
    workerName: string,
    workerRole: WorkerRole,
    commandPresetId: string
  ) => {
    if (!activeWorkspaceId) return { error: 'No active workspace' }
    const result = await createWorker(activeWorkspaceId, {
      autostart: true,
      command_preset_id: commandPresetId,
      hive_port: HIVE_PORT,
      name: workerName,
      role: workerRole,
    })
    setWorkersByWorkspaceId((current) => ({
      ...current,
      [activeWorkspaceId]: upsertWorker(current[activeWorkspaceId] ?? [], result.worker),
    }))
    return { error: result.agentStart.ok ? null : result.agentStart.error }
  }

  const handleDeleteWorker = async (workerId: string) => {
    if (!activeWorkspaceId) throw new Error('No active workspace')
    await deleteWorker(activeWorkspaceId, workerId)
    setWorkersByWorkspaceId((current) => ({
      ...current,
      [activeWorkspaceId]: (current[activeWorkspaceId] ?? []).filter(
        (worker) => worker.id !== workerId
      ),
    }))
  }

  const handleStartWorker = async (workerId: string) => {
    if (!activeWorkspaceId) return { error: 'No active workspace' }
    try {
      await startAgentRun(activeWorkspaceId, workerId, HIVE_PORT)
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: (current[activeWorkspaceId] ?? []).map((worker) =>
          worker.id === workerId ? { ...worker, status: 'idle' } : worker
        ),
      }))
      return { error: null }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  return (
    <MainLayout
      agentsAlive={agentsAlive}
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      runtimeAddress={RUNTIME_ADDRESS}
      sidebar={
        <Sidebar
          activeWorkspaceId={activeWorkspaceId}
          onCreateClick={() => setAddDialogTrigger((value) => value + 1)}
          onSelectWorkspace={selectWorkspace}
          workersByWorkspaceId={workersByWorkspaceId}
          workspaces={workspaces}
        />
      }
      taskGraphOpen={taskGraphOpen}
      workspaceCount={workspaces?.length ?? 0}
    >
      {workspaces
        ?.filter((workspace) => mountedWorkspaceIds.includes(workspace.id))
        .map((workspace) => (
          <WorkspaceTerminalPanels
            key={`terminal-${workspace.id}`}
            hidden={workspace.id !== activeWorkspaceId}
            workspaceId={workspace.id}
          />
        ))}
      <WorkspaceDetail
        hivePort={HIVE_PORT}
        onCreateWorker={handleCreateWorker}
        onDeleteWorker={handleDeleteWorker}
        onStartWorker={handleStartWorker}
        onOrchestratorResult={recordOrchestratorResult}
        orchestratorAutostartError={
          activeWorkspace ? (orchestratorAutostartErrors[activeWorkspace.id] ?? null) : null
        }
        workers={activeWorkers}
        workspace={activeWorkspace}
      />
      {activeWorkspace ? (
        <TaskGraphDrawer
          content={activeTasksFile.content}
          hasConflict={activeTasksFile.hasConflict}
          onClose={() => setTaskGraphOpen(false)}
          onContentChange={activeTasksFile.onChange}
          onKeepLocal={activeTasksFile.onKeepLocal}
          onReload={activeTasksFile.onReload}
          onSave={activeTasksFile.onSave}
          onToggleTaskLine={(line) => {
            void activeTasksFile.toggleTaskAtLine(line).catch(() => {})
          }}
          open={taskGraphOpen}
          workspacePath={activeWorkspace.path}
        />
      ) : null}
      <AddWorkspaceDialog
        onClose={() => {}}
        onCreate={(input) => {
          void createNewWorkspace(input)
        }}
        trigger={addDialogTrigger}
      />
    </MainLayout>
  )
}
