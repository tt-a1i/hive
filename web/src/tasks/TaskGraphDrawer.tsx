import {
  AtSign,
  CheckCircle2,
  ChevronRight,
  Circle,
  Code2,
  FileText,
  ListChecks,
  PanelRightClose,
} from 'lucide-react'
import { useState } from 'react'

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
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
  open,
  workspacePath,
}: TaskGraphDrawerProps) => {
  const [rawMode, setRawMode] = useState(false)
  const tasks = parseTaskMarkdown(content)
  const flatTasks = flattenTasks(tasks)
  const totalTasks = flatTasks.length
  const completedTasks = flatTasks.filter((task) => task.checked).length
  const openTasks = totalTasks - completedTasks
  const completionPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100)

  return (
    <aside
      aria-label="Task graph"
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
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-2 text-sec"
          aria-hidden
        >
          <ListChecks size={14} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-pri">Task Graph</span>
            <span className="rounded bg-2 px-1.5 py-0.5 text-xs uppercase text-ter">
              .hive/tasks.md
            </span>
          </div>
          {workspacePath ? (
            <div className="mono mt-0.5 truncate text-xs text-ter">
              {workspacePath}/.hive/tasks.md
            </div>
          ) : null}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setRawMode((v) => !v)}
          className={`icon-btn ${rawMode ? 'icon-btn--primary' : ''}`}
        >
          {rawMode ? <ListChecks size={14} /> : <Code2 size={14} />}
          <span>{rawMode ? 'done' : 'edit raw'}</span>
        </button>
        <Tooltip label="Close blueprint">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task graph"
            className="icon-btn"
          >
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
          <div className="task-empty">
            <FileText size={16} />
            <div>
              <div className="font-medium text-sec">没有任务条目</div>
              <div className="mt-1 text-xs text-ter">
                Orchestrator 写入 .hive/tasks.md 后会自动显示在这里。
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="task-summary" data-testid="task-graph-summary">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-xs uppercase text-ter">Progress</div>
                  <div className="mono mt-1 text-xl text-pri">
                    {completedTasks}/{totalTasks}
                  </div>
                </div>
                <div className="text-right">
                  <div className="mono text-lg text-sec">{completionPercent}%</div>
                  <div className="mt-1 text-xs text-ter">{openTasks} open</div>
                </div>
              </div>
              <div
                aria-label="Task completion"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={completionPercent}
                className="task-progress"
                data-testid="task-progress-bar"
                role="progressbar"
              >
                <span style={{ width: `${completionPercent}%` }} />
              </div>
            </div>
            <ul className="task-list" data-testid="task-graph-list">
              {tasks.map((task) => (
                <TaskItem key={task.line} onToggle={onToggleTaskLine} task={task} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  )
}
