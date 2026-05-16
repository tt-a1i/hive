import {
  AtSign,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  CornerDownRight,
  FileCode,
  FileText,
  PanelRightClose,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { renderInlineMarkdown } from './inline-markdown.js'
import { TaskGraphRawEditor } from './TaskGraphRawEditor.js'
import { countDirectCheckboxChildren, type ParsedTask, parseTaskMarkdown } from './task-markdown.js'
import { ownerToneFromName, parseTaskMetadata, type TaskMetaItem } from './task-meta.js'

/**
 * Max indent levels we render with nested visual structure. Beyond this we
 * flatten the subtree and prefix each row with `▸` — see §6.6.1. Pushing back
 * against deep nesting nudges Orchestrators to keep the tree readable rather
 * than carving the drawer into vertical strips at level 6+.
 */
const MAX_VISUAL_DEPTH = 3

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
  /**
   * Workspace's active worker roster. When provided, `@<name>` chips render
   * only for names that resolve to a real worker — see §6.6.2 fail-soft rule.
   * Omit for demo/fixture mode where any `@token` should chip.
   */
  knownWorkerNames?: readonly string[]
  /**
   * Click handler for an owner chip. When provided, chips render as buttons
   * and clicking one is the cross-pane "show me this worker" gesture.
   * Hover behavior (highlight without scroll) is up to the parent.
   */
  onSelectOwner?: (workerName: string) => void
  /**
   * Transport-layer connection flag from §3.5.2 / §3.6.5. When `true`, the
   * drawer is rendered with the `connection-stale` overlay and all write
   * paths (checkbox toggle, inline edit, add, raw-editor save) are disabled.
   * Reads (scroll, copy, expand/collapse) stay enabled.
   */
  connectionStale?: boolean
}

type OwnerChipHandlers = {
  /** Click handler: cross-pane jump to the worker card. */
  onSelectOwner?: (workerName: string) => void
}

const TaskMetaChip = ({ item, handlers }: { item: TaskMetaItem; handlers: OwnerChipHandlers }) => {
  if (item.kind === 'status') {
    return (
      <span className={`pill pill--${item.tone}`} data-testid="task-meta-status">
        {item.value}
      </span>
    )
  }
  if (item.kind === 'owner') {
    const tone = ownerToneFromName(item.value)
    const styleProps = { ['--owner-tone' as string]: tone }
    if (handlers.onSelectOwner) {
      // Owner chip becomes a button for the cross-pane "show me this worker"
      // gesture (§6.6.6). Stops the row's click-anywhere-to-edit affordance so
      // chip clicks don't open the inline editor.
      return (
        <button
          type="button"
          className="task-owner task-owner--clickable"
          data-testid="task-meta-owner"
          data-owner={item.value}
          onClick={(event) => {
            event.stopPropagation()
            handlers.onSelectOwner?.(item.value)
          }}
          style={styleProps}
        >
          <AtSign size={10} aria-hidden />
          {item.value}
        </button>
      )
    }
    return (
      <span
        className="task-owner"
        data-testid="task-meta-owner"
        data-owner={item.value}
        style={styleProps}
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
  /** Copy this task's raw markdown line to the clipboard (§6.6.6). */
  onCopyLine?: (lineIndex: number) => void
  /** Cross-pane jump to a worker card when their chip is clicked (§6.6.6). */
  onSelectOwner?: (workerName: string) => void
  /**
   * When `true`, all write affordances (toggle / edit / delete / add) are
   * visually present-but-disabled. Reads (copy, expand/collapse) stay active.
   * §6.6.4 — connection stale path.
   */
  writeDisabled?: boolean
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
  task,
  handlers,
  depth,
}: {
  task: ParsedTask
  handlers: TaskItemHandlers
  depth: number
}) => {
  const StatusIcon = task.checked ? CheckCircle2 : Circle
  const { title, meta } = parseTaskMetadata(task.text)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  // Folding state is per-row, in-memory only. Resets on remount
  // (workspace switch, drawer close+reopen) — see §6.6.5: never persisted.
  const [collapsed, setCollapsed] = useState(false)
  // §6.6.6 — transient "just copied" affordance on the Copy button. Swaps the
  // icon to ✓ for 1.5s so the user gets visual confirmation that the click
  // landed (otherwise the clipboard write is silent). State is per-row, so
  // copying multiple rows in quick succession each get their own checkmark.
  const [copied, setCopied] = useState(false)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Clear the pending timer on unmount so we don't `setState` on a dead
  // component (React 19 would warn; harmless but noisy).
  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )
  const {
    onToggle,
    onUpdateText,
    onDelete,
    onAppendSubtask,
    onCopyLine,
    onSelectOwner,
    writeDisabled = false,
  } = handlers
  const canEdit = Boolean(onUpdateText) && !writeDisabled
  const canDelete = Boolean(onDelete) && !writeDisabled
  const canAddSubtask = Boolean(onAppendSubtask) && !writeDisabled
  const canCopy = Boolean(onCopyLine)
  const showActions = !editing && !adding && (canEdit || canDelete || canAddSubtask || canCopy)
  const childCount = task.children.length
  const progress = countDirectCheckboxChildren(task)
  // §6.6.1 depth cap: at and below `MAX_VISUAL_DEPTH` we draw the usual
  // indented tree; beyond it children render *flat* (no further indent) with
  // a `▸` prefix so deep subtrees don't get crushed into a vertical strip.
  const childrenDeep = depth + 1 >= MAX_VISUAL_DEPTH
  const showCollapseToggle = childCount > 0
  const collapseLabel = collapsed
    ? `Expand ${childCount} subtask${childCount === 1 ? '' : 's'}`
    : `Collapse ${childCount} subtask${childCount === 1 ? '' : 's'}`
  const ownerHandlers: OwnerChipHandlers = onSelectOwner ? { onSelectOwner } : {}
  return (
    <li className="task-node" data-testid={`task-line-${task.line}`}>
      <div className="task-row group">
        {depth >= MAX_VISUAL_DEPTH ? (
          <span aria-hidden className="task-row__deep-marker">
            ▸
          </span>
        ) : null}
        <label className="task-row__checkbox-cell">
          <input
            type="checkbox"
            checked={task.checked}
            disabled={writeDisabled}
            onChange={() => {
              // Belt-and-suspenders: the `disabled` attribute already blocks
              // native user input, but synthetic events (jsdom test
              // environments, programmatic `.click()`) can route around it.
              // Guarding the handler here means §6.6.4 "no writes while
              // stale" holds regardless of how the change is fired.
              if (writeDisabled) return
              onToggle(task.line)
            }}
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
                {showCollapseToggle ? (
                  <button
                    type="button"
                    className="task-row__collapse"
                    onClick={(event) => {
                      event.stopPropagation()
                      setCollapsed((value) => !value)
                    }}
                    data-testid={`task-collapse-${task.line}`}
                    aria-expanded={!collapsed}
                    aria-label={collapseLabel}
                  >
                    {collapsed ? (
                      <ChevronRight size={12} aria-hidden />
                    ) : (
                      <ChevronDown size={12} aria-hidden />
                    )}
                  </button>
                ) : null}
                {progress ? (
                  <span
                    className="task-child-count mono"
                    data-testid={`task-progress-${task.line}`}
                    title={`${progress.done} of ${progress.total} direct subtasks complete`}
                  >
                    {progress.done}/{progress.total}
                  </span>
                ) : null}
              </span>
              {meta.length > 0 || task.mentions.length > 0 ? (
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {meta.map((item) => (
                    <TaskMetaChip
                      key={`${task.line}-meta-${item.kind}-${'label' in item ? item.label : ''}-${item.value}`}
                      item={item}
                      handlers={ownerHandlers}
                    />
                  ))}
                  {task.mentions.map((mention) => {
                    const owner = mention.replace(/^@/, '')
                    const styleProps = { ['--owner-tone' as string]: ownerToneFromName(owner) }
                    if (onSelectOwner) {
                      return (
                        <button
                          type="button"
                          className="task-owner task-owner--clickable"
                          data-testid={`task-mention-${owner}`}
                          data-owner={owner}
                          key={`${task.line}-mention-${mention}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            onSelectOwner(owner)
                          }}
                          style={styleProps}
                        >
                          <AtSign size={10} aria-hidden />
                          {owner}
                        </button>
                      )
                    }
                    return (
                      <span
                        className="task-owner"
                        data-testid={`task-mention-${owner}`}
                        data-owner={owner}
                        key={`${task.line}-mention-${mention}`}
                        style={styleProps}
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
            {canCopy ? (
              <Tooltip label={copied ? 'Copied' : 'Copy line'}>
                <button
                  type="button"
                  className="task-row__action"
                  onClick={() => {
                    onCopyLine?.(task.line)
                    setCopied(true)
                    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
                    copyTimeoutRef.current = setTimeout(() => {
                      setCopied(false)
                      copyTimeoutRef.current = null
                    }, 1500)
                  }}
                  data-testid={`task-copy-${task.line}`}
                  aria-label={copied ? 'Copied task line' : 'Copy task line'}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </Tooltip>
            ) : null}
            {canEdit ? (
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
            {canAddSubtask ? (
              <Tooltip label="Add subtask">
                <button
                  type="button"
                  className="task-row__action"
                  onClick={() => {
                    setCollapsed(false)
                    setAdding(true)
                  }}
                  data-testid={`task-add-subtask-${task.line}`}
                  aria-label="Add subtask"
                >
                  <CornerDownRight size={12} />
                </button>
              </Tooltip>
            ) : null}
            {canDelete ? (
              <Tooltip label="Delete">
                <button
                  type="button"
                  className="task-row__action task-row__action--danger"
                  onClick={() => onDelete?.(task.line)}
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
      {(childCount > 0 && !collapsed) || adding ? (
        <ul
          className={`task-children${childrenDeep ? ' task-children--deep' : ''}`}
          data-testid={`task-children-${task.line}`}
        >
          {!collapsed
            ? task.children.map((child) => (
                <TaskItem key={child.line} depth={depth + 1} handlers={handlers} task={child} />
              ))
            : null}
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

const AddTaskInline = ({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (text: string) => void
  disabled?: boolean
}) => {
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
        disabled={disabled}
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
  knownWorkerNames,
  onSelectOwner,
  connectionStale = false,
}: TaskGraphDrawerProps) => {
  const [rawMode, setRawMode] = useState(false)
  // Copy the *raw markdown line* from the source-of-truth content, not the
  // parsed `task.text` (which has mentions stripped). §6.6.6 — "paste back to
  // orchestrator" works best when the copied text matches what's on disk.
  const copyTaskLine = (lineIndex: number) => {
    const line = content.split(/\r?\n/)[lineIndex]
    if (typeof line !== 'string') return
    void navigator.clipboard?.writeText(line).catch((error: unknown) => {
      console.error('[hive] swallowed:tasks.copyLine', error)
    })
  }
  const taskHandlers: TaskItemHandlers = {
    onToggle: onToggleTaskLine,
    onCopyLine: copyTaskLine,
    ...(onUpdateTaskText && !connectionStale ? { onUpdateText: onUpdateTaskText } : {}),
    ...(onDeleteTask && !connectionStale ? { onDelete: onDeleteTask } : {}),
    ...(onAppendSubtask && !connectionStale ? { onAppendSubtask } : {}),
    ...(onSelectOwner ? { onSelectOwner } : {}),
    ...(connectionStale ? { writeDisabled: true } : {}),
  }
  const parseOptions = knownWorkerNames ? { knownWorkerNames } : {}
  const tasks = parseTaskMarkdown(content, parseOptions)
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

  // §6.6.7 — `Esc` closes the drawer when no inline editor is consuming the
  // key. We only handle it when the focused target is the drawer container or
  // its non-input children, so an open `<input>` (inline edit, add task) gets
  // first crack at the event.
  const onDrawerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    const tag = (event.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    event.preventDefault()
    onClose()
  }

  const drawerClassName = `drawer absolute right-0 top-0 bottom-0 z-20 flex flex-col border-l shadow-2xl${open ? ' open' : ''}${connectionStale ? ' drawer--stale' : ''}`

  return (
    <aside
      aria-label="Todo"
      data-testid="task-graph-drawer"
      data-connection-stale={connectionStale || undefined}
      aria-hidden={!open}
      onKeyDown={onDrawerKeyDown}
      className={drawerClassName}
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
                <AddTaskInline disabled={connectionStale} onSubmit={onAppendTask} />
              </div>
            ) : null}
            <EmptyState
              icon={<FileText size={20} />}
              title="No tasks yet"
              description="Ask the orchestrator in chat to start planning, or add your first task above to bootstrap .hive/tasks.md."
            />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <ul className="task-list" data-testid="task-graph-list">
              {openRoots.map((task) => (
                <TaskItem depth={0} handlers={taskHandlers} key={task.line} task={task} />
              ))}
              {onAppendTask ? (
                <li>
                  <AddTaskInline disabled={connectionStale} onSubmit={onAppendTask} />
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
                      <TaskItem depth={0} handlers={taskHandlers} key={task.line} task={task} />
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
