import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import type { FormEvent } from 'react'

type TaskGraphRawEditorProps = {
  content: string
  hasConflict: boolean
  onContentChange: (value: string) => void
  onKeepLocal: () => void
  onReload: () => void
  onSave: () => Promise<void>
}

/**
 * Raw markdown editor inside TaskGraphDrawer. Exposes the same field labels
 * the tasks-flow tests use (`Tasks Markdown` / `Save Tasks` / `Reload` / `Keep
 * Local` / `文件已在外部变化`) so the conflict + save path is driven from the
 * real UI rather than a hidden shim.
 */
export const TaskGraphRawEditor = ({
  content,
  hasConflict,
  onContentChange,
  onKeepLocal,
  onReload,
  onSave,
}: TaskGraphRawEditorProps) => {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void onSave()
  }
  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-3">
      <label className="flex min-h-0 flex-1 flex-col gap-2 text-xs text-sec">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium text-sec">Tasks Markdown</span>
          <span className="mono text-[10px] text-ter">{content.split(/\r?\n/).length} lines</span>
        </span>
        <textarea
          aria-label="Tasks Markdown"
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          className="mono min-h-[360px] flex-1 resize-none rounded-md border p-3 text-sm leading-6 text-pri outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
        />
      </label>
      {hasConflict ? (
        <div
          className="flex items-start gap-2 rounded-md border p-3 text-xs"
          style={{ borderColor: 'var(--status-orange)', color: 'var(--status-orange)' }}
        >
          <AlertTriangle className="mt-0.5 shrink-0" size={15} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">文件已在外部变化</p>
            <p className="mt-1 text-ter">重新载入会丢弃当前草稿；保留本地会继续编辑当前内容。</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onReload} className="icon-btn">
              <RefreshCw size={13} />
              Reload
            </button>
            <button type="button" onClick={onKeepLocal} className="icon-btn">
              Keep Local
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex justify-end border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button type="submit" className="icon-btn icon-btn--primary">
          <Save size={14} />
          Save Tasks
        </button>
      </div>
    </form>
  )
}
