import type { FsProbeResponse } from '../api.js'
import { useI18n } from '../i18n.js'

type FsSelectionPreviewProps = {
  probe: FsProbeResponse | null
  suggestedName: string
  onSuggestedNameChange: (value: string) => void
}

export const FsSelectionPreview = ({
  probe,
  suggestedName,
  onSuggestedNameChange,
}: FsSelectionPreviewProps) => {
  const { t } = useI18n()
  const hasProbe = !!probe && probe.ok && probe.is_dir
  return (
    <div
      className="flex flex-col gap-2 rounded border p-3 text-xs"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      data-testid="fs-selection-preview"
    >
      <div className="flex items-center justify-between">
        <span className="text-ter uppercase tracking-wider text-xs">
          {t('workspace.browse.selected')}
        </span>
        {probe?.is_git_repository ? (
          <span className="role-badge role-badge--coder" data-testid="fs-preview-git-badge">
            {t('workspace.git.short', {
              branch: probe.current_branch ?? t('workspace.git.detached'),
            })}
          </span>
        ) : hasProbe ? (
          <span className="text-ter text-xs">{t('workspace.git.noneShort')}</span>
        ) : null}
      </div>
      <span className="mono truncate text-pri" data-testid="fs-preview-path">
        {probe?.path ?? '—'}
      </span>
      <label className="mt-1 flex flex-col gap-1 text-ter">
        <span className="text-xs uppercase tracking-wider">{t('workspace.field.name')}</span>
        <input
          type="text"
          value={suggestedName}
          onChange={(event) => onSuggestedNameChange(event.target.value)}
          disabled={!hasProbe}
          className="mono rounded border px-2 py-1 text-sm text-pri disabled:opacity-50"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
          data-testid="fs-preview-name-input"
        />
      </label>
    </div>
  )
}
