import { logSwallowed } from '../lib/log-swallowed.js'
import { TaskGraphDrawer } from './TaskGraphDrawer.js'
import { useTasksFile } from './useTasksFile.js'

type Props = {
  demoMode: boolean
  demoContent?: string
  workspaceId: string | null
  workspacePath: string
  open: boolean
  onClose: () => void
}

/**
 * Wires `useTasksFile` into the TaskGraphDrawer for the current workspace.
 * Demo mode swaps the file fetch for a static fixture; production polls server.
 * Kept as its own component so App can stay under the 150-line cap.
 */
export const WorkspaceTaskDrawer = ({
  demoMode,
  demoContent,
  workspaceId,
  workspacePath,
  open,
  onClose,
}: Props) => {
  const tasksFile = useTasksFile(demoMode ? null : workspaceId, demoMode ? demoContent : undefined)
  return (
    <TaskGraphDrawer
      content={tasksFile.content}
      hasConflict={tasksFile.hasConflict}
      onClose={onClose}
      onContentChange={tasksFile.onChange}
      onKeepLocal={tasksFile.onKeepLocal}
      onReload={tasksFile.onReload}
      onSave={tasksFile.onSave}
      onToggleTaskLine={(line) => {
        void tasksFile.toggleTaskAtLine(line).catch(logSwallowed('tasks.toggleTaskAtLine'))
      }}
      open={open}
      workspacePath={workspacePath}
    />
  )
}
