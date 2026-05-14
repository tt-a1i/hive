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
}: AppOverlaysProps) => (
  <>
    {workspacePath ? (
      <WorkspaceTaskDrawer
        open={taskGraphOpen}
        tasksFile={tasksFile}
        onClose={onCloseTaskGraph}
        workspacePath={workspacePath}
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
