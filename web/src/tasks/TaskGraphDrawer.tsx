import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  FileText,
  PanelRightClose,
  Plus,
} from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'

import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { renderInlineMarkdown } from './inline-markdown.js'
import { TaskGraphRawEditor } from './TaskGraphRawEditor.js'
import { type ParsedTask, parseTaskMarkdown } from './task-markdown.js'
import { parseTaskMetadata, type TaskMetaItem } from './task-meta.js'

type TaskGraphDrawerProps = {
  content: string
  hasConflict: boolean
  onClose: () => void
  onContentChange: (value: string) => void
  onKeepLocal: () => void
  onReload: () => void
  onSave: () => Promise<void>
  onToggleTaskLine: (lineIndex: number) => void
  onAppendTask?: (text: string) => void
  open: boolean
  workspacePath: string | null
}

const TaskMetaChip = ({ item }: { item: TaskMetaItem }) => {
  if (item.kind === 'status') {
    return (
      <span className={`pill pill--${item.tone}`} data-testid="task-meta-status">
        {item.value}
      </span>
    )
  }
  if (item.kind === 'owner') {
    return (
      <span className="task-mention inline-flex items-center gap-1" data-testid="task-meta-owner">
        <AtSign size={10} aria-hidden />
        {item.value}
      </span>
    )
  }
  if (item.kind === 'path') {
    return (
      <span
        className="pill pill--neutral mono inline-flex items-center gap-1"
        data-testid="task-meta-path"
        title={`${item.label}: ${item.value}`}
      >
        <FileText size={10} aria-hidden />
        {item.value}
      </span>
    )
  }
  return (
    <span className="text-xs text-ter" data-testid="task-meta-note">
      {item.value}
    </span>
  )
}

const TaskItem = ({
  depth = 0,
  onToggle,
  task,
}: {
  depth?: number
  onToggle: (lineIndex: number) => void
  task: ParsedTask
}) => {
  const StatusIcon = task.checked ? CheckCircle2 : Circle
  const { title, meta } = parseTaskMetadata(task.text)
  return (
    <li className="task-node" data-testid={`task-line-${task.line}`}>
      <label
        className="group flex min-w-0 cursor-pointer items-start gap-3 rounded px-2.5 py-2 transition-colors hover:bg-2"
        style={{ marginLeft: depth ? 14 : 0 }}
      >
        <input
          type="checkbox"
          checked={task.checked}
          onChange={() => onToggle(task.line)}
          className="sr-only"
          data-testid={`task-checkbox-${task.line}`}
          aria-label={task.text || `task-line-${task.line}`}
        />
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            task.checked ? 'task-status-done' : 'task-status-open'
          }`}
          aria-hidden
        >
          <StatusIcon size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-2">
            <span
              className={`min-w-0 flex-1 text-base ${
                task.checked ? 'text-ter line-through' : 'text-pri'
              }`}
            >
              {renderInlineMarkdown(title)}
            </span>
            {task.children.length > 0 ? (
              <span className="task-child-count mono">
                <ChevronRight size={12} />
                {task.children.length}
              </span>
            ) : null}
          </span>
          {meta.length > 0 || task.mentions.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-2">
              {meta.map((item, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: meta order is deterministic from immutable task.text — items never re-sort within a task
                <TaskMetaChip key={`${task.line}-meta-${idx}`} item={item} />
              ))}
              {task.mentions.map((mention) => (
                <span className="task-mention" key={`${task.line}-mention-${mention}`}>
                  {mention}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </label>
      {task.children.length > 0 ? (
        <ul className="task-children">
          {task.children.map((child) => (
            <TaskItem depth={depth + 1} key={child.line} onToggle={onToggle} task={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

const AddTaskInline = ({ onSubmit }: { onSubmit: (text: string) => void }) => {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setOpen(false)
      return
    }
    onSubmit(trimmed)
    setValue('')
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setValue('')
      setOpen(false)
    }
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="task-add-toggle"
        className="group flex w-full cursor-pointer items-center gap-3 rounded px-2.5 py-2 text-left text-sm text-ter transition-colors hover:bg-2 hover:text-sec"
      >
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <Plus size={12} />
        </span>
        <span>Add task</span>
      </button>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded px-2.5 py-2">
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--bg-3)', color: 'var(--text-secondary)' }}
      >
        <Plus size={12} />
      </span>
      <input
        type="text"
        // biome-ignore lint/a11y/noAutofocus: this input is mounted in direct response to a user click on the Add task affordance
        autoFocus
        value={value}
        placeholder="What needs to be done?"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKey}
        onBlur={submit}
        data-testid="task-add-input"
        className="min-w-0 flex-1 bg-transparent text-base text-pri outline-none placeholder:text-ter"
      />
    </div>
  )
}

const flattenTasks = (tasks: ParsedTask[]): ParsedTask[] =>
  tasks.flatMap((task) => [task, ...flattenTasks(task.children)])

export const TaskGraphDrawer = ({
  content,
  hasConflict,
  onClose,
  onContentChange,
  onKeepLocal,
  onReload,
  onSave,
  onToggleTaskLine,
  onAppendTask,
  open,
  workspacePath,
}: TaskGraphDrawerProps) => {
  const [rawMode, setRawMode] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const tasks = parseTaskMarkdown(content)
  const flatTasks = flattenTasks(tasks)
  const totalTasks = flatTasks.length
  const completedTasks = flatTasks.filter((task) => task.checked).length
  const completionPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100)

  // Partition top-level tasks: open vs done. Children stay nested under
  // their parent regardless (a parent's checked flag doesn't hide its
  // subtree). This is the simplest grouping that calms a long list
  // without losing the tree structure.
  const openRoots = tasks.filter((task) => !task.checked)
  const doneRoots = tasks.filter((task) => task.checked)
  const filePath = workspacePath ? `${workspacePath}/.hive/tasks.md` : '.hive/tasks.md'

  return (
    <aside
      aria-label="Todo"
      data-testid="task-graph-drawer"
      aria-hidden={!open}
      className={`drawer absolute right-0 top-0 bottom-0 z-20 flex flex-col border-l shadow-2xl${open ? ' open' : ''}`}
      style={{
        background: 'var(--bg-1)',
        borderColor: 'var(--border)',
        maxWidth: 'calc(100vw - 3.5rem)',
        width: 520,
      }}
    >
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <Tooltip label={<span className="mono text-ter">{filePath}</span>}>
          <span className="cursor-default font-semibold text-pri">Todo</span>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip label="Close Todo">
          <button type="button" onClick={onClose} aria-label="Close Todo" className="icon-btn">
            <PanelRightClose size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 scroll-y px-4 py-3 text-sm">
        {rawMode ? (
          <TaskGraphRawEditor
            content={content}
            hasConflict={hasConflict}
            onContentChange={onContentChange}
            onKeepLocal={onKeepLocal}
            onReload={onReload}
            onSave={onSave}
          />
        ) : tasks.length === 0 ? (
          <>
            {onAppendTask ? (
              <div className="mb-1">
                <AddTaskInline onSubmit={onAppendTask} />
              </div>
            ) : null}
            <EmptyState
              icon={<FileText size={20} />}
              title="No tasks yet"
              description="The Orchestrator writes .hive/tasks.md as it plans, or add your first task above."
            />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <div data-testid="task-graph-summary" className="px-2.5">
              <div className="flex items-center justify-between gap-3 text-xs text-ter tabular-nums">
                <span data-testid="task-progress-text">
                  {completedTasks} of {totalTasks} done
                </span>
                <span>{completionPercent}%</span>
              </div>
              <div
                aria-label="Task completion"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={completionPercent}
                className="task-progress-thin mt-1.5"
                data-testid="task-progress-bar"
                role="progressbar"
              >
                <span style={{ width: `${completionPercent}%` }} />
              </div>
            </div>
            <ul className="task-list mt-1" data-testid="task-graph-list">
              {openRoots.map((task) => (
                <TaskItem key={task.line} onToggle={onToggleTaskLine} task={task} />
              ))}
              {onAppendTask ? (
                <li>
                  <AddTaskInline onSubmit={onAppendTask} />
                </li>
              ) : null}
            </ul>
            {doneRoots.length > 0 ? (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => setCompletedOpen((v) => !v)}
                  aria-expanded={completedOpen}
                  data-testid="task-completed-toggle"
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-xs text-ter transition-colors hover:bg-2 hover:text-sec"
                >
                  {completedOpen ? (
                    <ChevronDown size={12} aria-hidden />
                  ) : (
                    <ChevronRight size={12} aria-hidden />
                  )}
                  <span>{doneRoots.length} completed</span>
                </button>
                {completedOpen ? (
                  <ul className="task-list" data-testid="task-completed-list">
                    {doneRoots.map((task) => (
                      <TaskItem key={task.line} onToggle={onToggleTaskLine} task={task} />
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div
        className="flex shrink-0 items-center justify-end border-t px-4 py-2 text-xs"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setRawMode((v) => !v)}
          data-testid="task-raw-toggle"
          className="cursor-pointer text-ter hover:text-pri hover:underline"
        >
          {rawMode ? 'Back to list' : 'View source'}
        </button>
      </div>
    </aside>
  )
}
