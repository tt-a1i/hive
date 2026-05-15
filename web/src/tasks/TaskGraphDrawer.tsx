import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CornerDownRight,
  FileCode,
  FileText,
  PanelRightClose,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'

import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { renderInlineMarkdown } from './inline-markdown.js'
import { TaskGraphRawEditor } from './TaskGraphRawEditor.js'
import { type ParsedTask, parseTaskMarkdown } from './task-markdown.js'
import { ownerToneFromName, parseTaskMetadata, type TaskMetaItem } from './task-meta.js'

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
  onAppendSubtask?: (parentLine: number, text: string) => void
  onUpdateTaskText?: (lineIndex: number, nextText: string) => void
  onDeleteTask?: (lineIndex: number) => void
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
    const tone = ownerToneFromName(item.value)
    return (
      <span
        className="task-owner"
        data-testid="task-meta-owner"
        style={{ ['--owner-tone' as string]: tone }}
      >
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

type TaskItemHandlers = {
  onToggle: (lineIndex: number) => void
  onUpdateText?: (lineIndex: number, nextText: string) => void
  onDelete?: (lineIndex: number) => void
  onAppendSubtask?: (parentLine: number, text: string) => void
}

const TaskInlineEditor = ({
  initial,
  onSubmit,
  onCancel,
  placeholder,
}: {
  initial: string
  onSubmit: (next: string) => void
  onCancel: () => void
  placeholder?: string
}) => {
  const [value, setValue] = useState(initial)
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) {
      onCancel()
      return
    }
    onSubmit(trimmed)
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }
  return (
    <input
      type="text"
      // biome-ignore lint/a11y/noAutofocus: only mounted in response to a direct user activation (Edit/Add-subtask button)
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKey}
      onBlur={submit}
      data-testid="task-inline-input"
      className="task-row__input"
    />
  )
}

const TaskItem = ({
  depth = 0,
  task,
  handlers,
}: {
  depth?: number
  task: ParsedTask
  handlers: TaskItemHandlers
}) => {
  const StatusIcon = task.checked ? CheckCircle2 : Circle
  const { title, meta } = parseTaskMetadata(task.text)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const { onToggle, onUpdateText, onDelete, onAppendSubtask } = handlers
  const showActions = !editing && !adding && Boolean(onUpdateText || onDelete || onAppendSubtask)
  return (
    <li className="task-node" data-testid={`task-line-${task.line}`}>
      <div className="task-row group">
        <label className="task-row__checkbox-cell">
          <input
            type="checkbox"
            checked={task.checked}
            onChange={() => onToggle(task.line)}
            className="sr-only"
            data-testid={`task-checkbox-${task.line}`}
            aria-label={task.text || `task-line-${task.line}`}
          />
          <span
            className={`task-row__indicator ${task.checked ? 'task-status-done' : 'task-status-open'}`}
            aria-hidden
          >
            <StatusIcon size={14} />
          </span>
        </label>
        <span className="min-w-0 flex-1">
          {editing ? (
            <TaskInlineEditor
              initial={task.text}
              placeholder="Edit task"
              onSubmit={(next) => {
                setEditing(false)
                onUpdateText?.(task.line, next)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <span className="flex min-w-0 items-start gap-2">
                <span
                  className={`task-row__title min-w-0 flex-1 ${
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
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {meta.map((item, idx) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: meta order is deterministic from immutable task.text — items never re-sort within a task
                    <TaskMetaChip key={`${task.line}-meta-${idx}`} item={item} />
                  ))}
                  {task.mentions.map((mention) => {
                    const owner = mention.replace(/^@/, '')
                    return (
                      <span
                        className="task-owner"
                        key={`${task.line}-mention-${mention}`}
                        style={{ ['--owner-tone' as string]: ownerToneFromName(owner) }}
                      >
                        <AtSign size={10} aria-hidden />
                        {owner}
                      </span>
                    )
                  })}
                </span>
              ) : null}
            </>
          )}
        </span>
        {showActions ? (
          <div className="task-row__actions">
            {onUpdateText ? (
              <Tooltip label="Edit">
                <button
                  type="button"
                  className="task-row__action"
                  onClick={() => setEditing(true)}
                  data-testid={`task-edit-${task.line}`}
                  aria-label="Edit task"
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
            ) : null}
            {onAppendSubtask ? (
              <Tooltip label="Add subtask">
                <button
                  type="button"
                  className="task-row__action"
                  onClick={() => setAdding(true)}
                  data-testid={`task-add-subtask-${task.line}`}
                  aria-label="Add subtask"
                >
                  <CornerDownRight size={12} />
                </button>
              </Tooltip>
            ) : null}
            {onDelete ? (
              <Tooltip label="Delete">
                <button
                  type="button"
                  className="task-row__action task-row__action--danger"
                  onClick={() => onDelete(task.line)}
                  data-testid={`task-delete-${task.line}`}
                  aria-label="Delete task"
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      {task.children.length > 0 || adding ? (
        <ul className="task-children">
          {task.children.map((child) => (
            <TaskItem depth={depth + 1} key={child.line} handlers={handlers} task={child} />
          ))}
          {adding ? (
            <li className="task-node">
              <div className="task-row task-row--child-input">
                <span aria-hidden className="task-row__indicator task-status-open">
                  <CornerDownRight size={12} />
                </span>
                <TaskInlineEditor
                  initial=""
                  placeholder="New subtask"
                  onSubmit={(next) => {
                    setAdding(false)
                    onAppendSubtask?.(task.line, next)
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            </li>
          ) : null}
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
        className="task-add-toggle"
      >
        <span aria-hidden className="task-add-toggle__icon">
          <Plus size={12} />
        </span>
        <span>Add task</span>
      </button>
    )
  }
  return (
    <div className="task-add-input">
      <span aria-hidden className="task-add-input__icon">
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
        className="task-add-input__field"
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
  onAppendSubtask,
  onUpdateTaskText,
  onDeleteTask,
  open,
  workspacePath,
}: TaskGraphDrawerProps) => {
  const [rawMode, setRawMode] = useState(false)
  const taskHandlers: TaskItemHandlers = {
    onToggle: onToggleTaskLine,
    ...(onUpdateTaskText ? { onUpdateText: onUpdateTaskText } : {}),
    ...(onDeleteTask ? { onDelete: onDeleteTask } : {}),
    ...(onAppendSubtask ? { onAppendSubtask } : {}),
  }
  const tasks = parseTaskMarkdown(content)
  const flatTasks = flattenTasks(tasks)
  const totalTasks = flatTasks.length
  const completedTasks = flatTasks.filter((task) => task.checked).length
  const completionPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100)

  // Partition top-level tasks: open vs done. Children stay nested under
  // their parent regardless (a parent's checked flag doesn't hide its
  // subtree).
  const openRoots = tasks.filter((task) => !task.checked)
  const doneRoots = tasks.filter((task) => task.checked)
  // Default to expanded when the completed cohort is small enough that
  // hiding it feels like the UI "ate" the user's just-checked task.
  const [completedOpen, setCompletedOpen] = useState(doneRoots.length <= 3)
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
      <header className="task-drawer__header">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <Tooltip label={<span className="mono text-ter">{filePath}</span>}>
            <span className="cursor-default font-semibold text-pri">Todo</span>
          </Tooltip>
          {totalTasks > 0 ? (
            <span className="text-xs text-ter tabular-nums" data-testid="task-graph-summary">
              <span data-testid="task-progress-text">
                {completedTasks} / {totalTasks}
              </span>{' '}
              · {completionPercent}%
            </span>
          ) : null}
        </div>
        <Tooltip label={rawMode ? 'Back to list' : 'View source'}>
          <button
            type="button"
            onClick={() => setRawMode((v) => !v)}
            data-testid="task-raw-toggle"
            className="icon-btn"
            aria-label={rawMode ? 'Back to list' : 'View source'}
          >
            <FileCode size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Close Todo">
          <button type="button" onClick={onClose} aria-label="Close Todo" className="icon-btn">
            <PanelRightClose size={14} />
          </button>
        </Tooltip>
      </header>
      {!rawMode && totalTasks > 0 ? (
        <div
          aria-label="Task completion"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={completionPercent}
          className="task-progress-thin task-drawer__progress"
          data-testid="task-progress-bar"
          role="progressbar"
        >
          <span style={{ width: `${completionPercent}%` }} />
        </div>
      ) : null}
      <div className="flex-1 scroll-y px-3 py-3 text-sm">
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
            <ul className="task-list" data-testid="task-graph-list">
              {openRoots.map((task) => (
                <TaskItem key={task.line} handlers={taskHandlers} task={task} />
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
                  className="task-completed-toggle"
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
                      <TaskItem key={task.line} handlers={taskHandlers} task={task} />
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}
