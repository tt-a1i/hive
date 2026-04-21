import { useState } from 'react'

import { TaskGraphRawEditor } from './TaskGraphRawEditor.js'
import { type ParsedTask, parseTaskMarkdown } from './task-markdown.js'

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

const TaskItem = ({
  onToggle,
  task,
}: {
  onToggle: (lineIndex: number) => void
  task: ParsedTask
}) => (
  <li>
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={task.checked}
        onChange={() => onToggle(task.line)}
        className="mt-1"
        style={{ accentColor: 'var(--accent)' }}
        data-testid={`task-checkbox-${task.line}`}
        aria-label={task.text || `task-line-${task.line}`}
      />
      <div className="flex-1">
        <span
          className={task.checked ? 'line-through text-ter' : 'text-pri'}
          style={task.checked ? undefined : { color: 'var(--text-primary)' }}
        >
          {task.text}
        </span>
        {task.mentions.length > 0 ? (
          <span className="ml-2 text-[11px] text-ter">{task.mentions.join(' ')}</span>
        ) : null}
        {task.children.length > 0 ? (
          <ul className="ml-4 mt-1 space-y-1.5">
            {task.children.map((child) => (
              <TaskItem key={child.line} onToggle={onToggle} task={child} />
            ))}
          </ul>
        ) : null}
      </div>
    </label>
  </li>
)

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
  return (
    <aside
      aria-label="Task graph"
      data-testid="task-graph-drawer"
      aria-hidden={!open}
      className={`drawer absolute right-0 top-0 bottom-0 z-20 flex w-[400px] flex-col border-l shadow-2xl${open ? ' open' : ''}`}
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-lg leading-none" aria-hidden>
          📋
        </span>
        <span className="font-medium text-pri">tasks.md</span>
        {workspacePath ? (
          <span className="mono truncate text-[11px] text-ter">{workspacePath}/tasks.md</span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setRawMode((v) => !v)}
          className="rounded px-2 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
        >
          {rawMode ? 'done' : 'edit raw'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task graph"
          className="px-2 text-lg leading-none text-sec hover:text-pri"
        >
          ×
        </button>
      </div>
      <div className="flex-1 scroll-y p-4 text-sm">
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
          <p className="text-ter">没有任务条目。Orchestrator 可以用 Edit 工具写入 tasks.md。</p>
        ) : (
          <ul className="space-y-2" data-testid="task-graph-list">
            {tasks.map((task) => (
              <TaskItem key={task.line} onToggle={onToggleTaskLine} task={task} />
            ))}
          </ul>
        )}
        <div className="mt-6 text-[11px] text-ter">
          提示：orch 用 Edit 工具直接改这份 markdown；用户也能在这里点击勾选。
        </div>
      </div>
    </aside>
  )
}
