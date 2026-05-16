import type { TeamListItem } from '../../src/shared/types.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import { WorkspaceTaskDrawer } from './tasks/WorkspaceTaskDrawer.js'
import { FirstRunWizard } from './wizard/FirstRunWizard.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'
import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

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
  workspacePath,
  workers,
  onSelectOwner,
  connectionStale,
}: AppOverlaysProps) => (
  <>
    {workspacePath ? (
      <WorkspaceTaskDrawer
        open={taskGraphOpen}
        tasksFile={tasksFile}
        onClose={onCloseTaskGraph}
        workspacePath={workspacePath}
        {...(workers ? { workers } : {})}
        {...(onSelectOwner ? { onSelectOwner } : {})}
        {...(connectionStale !== undefined ? { connectionStale } : {})}
      />
    ) : null}
    <AddWorkspaceDialog
      onClose={() => {}}
      onCreate={onCreateWorkspace}
      trigger={addDialogTrigger}
    />
    <FirstRunWizard
      open={wizardOpen}
      onClose={onCloseWizard}
      onAddWorkspace={onAddWorkspace}
      onTryDemo={onTryDemo}
    />
  </>
)
