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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-sec">
        Tasks Markdown
        <textarea
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          className="mono min-h-[160px] rounded border p-2 text-sm text-pri"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
        />
      </label>
      {hasConflict ? (
        <div
          className="rounded border p-2 text-xs"
          style={{ borderColor: 'var(--status-orange)', color: 'var(--status-orange)' }}
        >
          <p>文件已在外部变化</p>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={onReload}
              className="rounded px-2 py-0.5 text-xs text-sec hover:bg-3 hover:text-pri"
              style={{ border: '1px solid var(--border)' }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={onKeepLocal}
              className="rounded px-2 py-0.5 text-xs text-sec hover:bg-3 hover:text-pri"
              style={{ border: '1px solid var(--border)' }}
            >
              Keep Local
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex justify-end pt-1">
        <button
          type="submit"
          className="rounded px-3 py-1 text-xs text-white hover:opacity-90"
          style={{ background: 'var(--accent)' }}
        >
          Save Tasks
        </button>
      </div>
    </form>
  )
}
