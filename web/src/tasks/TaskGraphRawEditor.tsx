import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import type { FormEvent } from 'react'

import { useI18n } from '../i18n.js'

type TaskGraphRawEditorProps = {
  content: string
  hasConflict: boolean
  onContentChange: (value: string) => void
  onKeepLocal: () => void
  onReload: () => void
  onSave: () => Promise<void>
}

/**
 * Raw markdown editor inside TaskGraphDrawer. Labels run through i18n
 * (`tasks.raw.*`); the conflict banner and the Reload / Keep local / Save
 * tasks actions used to be hardcoded in mixed Chinese/English — moved here
 * so they switch languages together.
 */
export const TaskGraphRawEditor = ({
  content,
  hasConflict,
  onContentChange,
  onKeepLocal,
  onReload,
  onSave,
}: TaskGraphRawEditorProps) => {
  const { t } = useI18n()
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void onSave()
  }
  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-3">
      <label className="flex min-h-0 flex-1 flex-col gap-2 text-xs text-sec">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium text-sec">{t('tasks.raw.label')}</span>
          <span className="mono text-xs text-ter">
            {t('tasks.raw.lineCount', { count: content.split(/\r?\n/).length })}
          </span>
        </span>
        <textarea
          aria-label={t('tasks.raw.label')}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          className="mono min-h-[360px] flex-1 resize-none rounded border p-3 text-sm text-pri outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
        />
      </label>
      {hasConflict ? (
        <div
          className="flex items-start gap-2 rounded border p-3 text-xs"
          style={{ borderColor: 'var(--status-orange)', color: 'var(--status-orange)' }}
        >
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('tasks.raw.conflictTitle')}</p>
            <p className="mt-1 text-ter">{t('tasks.raw.conflictDescription')}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onReload} className="icon-btn">
              <RefreshCw size={14} />
              {t('tasks.raw.reload')}
            </button>
            <button type="button" onClick={onKeepLocal} className="icon-btn">
              {t('tasks.raw.keepLocal')}
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex justify-end border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button type="submit" className="icon-btn icon-btn--primary">
          <Save size={14} />
          {t('tasks.raw.save')}
        </button>
      </div>
    </form>
  )
}
