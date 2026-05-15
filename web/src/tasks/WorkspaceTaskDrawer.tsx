import { logSwallowed } from '../lib/log-swallowed.js'
import { TaskGraphDrawer } from './TaskGraphDrawer.js'
import type { useTasksFile } from './useTasksFile.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

type Props = {
  tasksFile: TasksFileApi
  workspacePath: string
  open: boolean
  onClose: () => void
}

/**
 * Thin adapter: takes a pre-mounted `useTasksFile` state and wires it
 * into the TaskGraphDrawer. The hook lives one level up (App.tsx) so
 * the Topbar can read open-task count off the same subscription
 * without spawning a second WS connection.
 */
export const WorkspaceTaskDrawer = ({ tasksFile, workspacePath, open, onClose }: Props) => (
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
    onAppendTask={(text) => {
      void tasksFile.appendTask(text).catch(logSwallowed('tasks.appendTask'))
    }}
    onAppendSubtask={(parentLine, text) => {
      void tasksFile.appendSubtask(parentLine, text).catch(logSwallowed('tasks.appendSubtask'))
    }}
    onUpdateTaskText={(line, nextText) => {
      void tasksFile.updateTaskText(line, nextText).catch(logSwallowed('tasks.updateTaskText'))
    }}
    onDeleteTask={(line) => {
      void tasksFile.deleteTask(line).catch(logSwallowed('tasks.deleteTask'))
    }}
    open={open}
    workspacePath={workspacePath}
  />
)
