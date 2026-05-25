import { useMemo } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { logSwallowed } from '../lib/log-swallowed.js'
import { TaskGraphDrawer } from './TaskGraphDrawer.js'
import type { useTasksFile } from './useTasksFile.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

type Props = {
  tasksFile: TasksFileApi
  workspaceId: string | null
  workspacePath: string
  open: boolean
  onClose: () => void
  /**
   * Active worker roster for this workspace. Used for §6.6.2 fail-soft chip
   * resolution (`@<name>` only renders as a chip when it matches a real
   * worker) and to drive the §6.6.6 cross-pane jump on chip click.
   */
  workers?: readonly TeamListItem[]
  /**
   * Cross-pane jump handler. Called when the user clicks an `@<name>` chip in
   * the drawer; parent typically scrolls the matching worker card into view
   * and applies a transient highlight. Hover behavior is intentionally
   * pure-CSS (no scroll) — see §6.6.6.
   */
  onSelectOwner?: (workerName: string) => void
  /**
   * §3.5.2 / §3.6.5 transport disconnect flag. Passed through unchanged.
   */
  connectionStale?: boolean
}

/**
 * Dormant Task Graph/Blueprint adapter. Early Hive treated `.hive/tasks.md`
 * as a first-class planning surface, but current usage relies on the
 * Orchestrator agent's own planning more than a second visible task system.
 * Keep this adapter wired and tested for existing workspaces and future revival.
 */
export const WorkspaceTaskDrawer = ({
  tasksFile,
  workspaceId,
  workspacePath,
  open,
  onClose,
  workers,
  onSelectOwner,
  connectionStale,
}: Props) => {
  // Map down to bare names for the drawer; the drawer doesn't need any other
  // worker metadata (status/role/etc) — its chip parser is name-only. An empty
  // roster is collapsed to `undefined` so the parser falls back to permissive
  // mode (any `@token` chips). The "explicit empty = strict" branch stays
  // available for direct callers via `parseTaskMarkdown(content, { knownWorkerNames: [] })`.
  const knownWorkerNames = useMemo(
    () => (workers?.length ? workers.map((w) => w.name) : undefined),
    [workers]
  )
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
      workspaceId={workspaceId}
      workspacePath={workspacePath}
      {...(knownWorkerNames ? { knownWorkerNames } : {})}
      {...(onSelectOwner ? { onSelectOwner } : {})}
      {...(connectionStale !== undefined ? { connectionStale } : {})}
    />
  )
}
