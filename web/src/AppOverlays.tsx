import { lazy, Suspense } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

const WorkspaceTaskDrawer = lazy(() =>
  import('./tasks/WorkspaceTaskDrawer.js').then((module) => ({
    default: module.WorkspaceTaskDrawer,
  }))
)
const AddWorkspaceDialog = lazy(() =>
  import('./workspace/AddWorkspaceDialog.js').then((module) => ({
    default: module.AddWorkspaceDialog,
  }))
)
const FirstRunWizard = lazy(() =>
  import('./wizard/FirstRunWizard.js').then((module) => ({ default: module.FirstRunWizard }))
)

type AppOverlaysProps = {
  addDialogTrigger: number
  onAddWorkspace: () => void
  onCloseTaskGraph: () => void
  onCloseWizard: (shouldMarkSeen?: boolean) => void
  onCreateWorkspace: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
  onTryDemo: () => void
  taskGraphOpen: boolean
  tasksFile: TasksFileApi
  wizardOpen: boolean
  workspaceId: string | null
  workspacePath: string | null
  /** Workspace's active worker roster — feeds the §6.6.2 chip resolution. */
  workers?: readonly TeamListItem[]
  /** Cross-pane jump on chip click (§6.6.6). */
  onSelectOwner?: (workerName: string) => void
  /** §3.5.2 transport disconnect flag passed through unchanged. */
  connectionStale?: boolean
}

export const AppOverlays = ({
  addDialogTrigger,
  onAddWorkspace,
  onCloseTaskGraph,
  onCloseWizard,
  onCreateWorkspace,
  onTryDemo,
  taskGraphOpen,
  tasksFile,
  wizardOpen,
  workspaceId,
  workspacePath,
  workers,
  onSelectOwner,
  connectionStale,
}: AppOverlaysProps) => (
  <>
    {workspacePath ? (
      /* Dormant Task Graph/Blueprint surface. App passes `open=false` while
         TASK_GRAPH_PRIMARY_ENTRY_ENABLED is disabled; keep it wired so older
         `.hive/tasks.md` workspaces and future reactivation have a tested path. */
      <Suspense fallback={null}>
        <WorkspaceTaskDrawer
          open={taskGraphOpen}
          tasksFile={tasksFile}
          onClose={onCloseTaskGraph}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          {...(workers ? { workers } : {})}
          {...(onSelectOwner ? { onSelectOwner } : {})}
          {...(connectionStale !== undefined ? { connectionStale } : {})}
        />
      </Suspense>
    ) : null}
    {addDialogTrigger > 0 ? (
      <Suspense fallback={null}>
        <AddWorkspaceDialog
          onClose={() => {}}
          onCreate={onCreateWorkspace}
          trigger={addDialogTrigger}
        />
      </Suspense>
    ) : null}
    {wizardOpen ? (
      <Suspense fallback={null}>
        <FirstRunWizard
          open={wizardOpen}
          onClose={onCloseWizard}
          onAddWorkspace={onAddWorkspace}
          onTryDemo={onTryDemo}
        />
      </Suspense>
    ) : null}
  </>
)
