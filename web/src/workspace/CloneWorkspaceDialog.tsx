import * as Dialog from '@radix-ui/react-dialog'
import { type FormEvent, useState } from 'react'

import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { cloneWorkspace } from '../api.js'
import { useI18n } from '../i18n.js'

type CloneWorkspaceDialogProps = {
  open: boolean
  onClose: () => void
  onCloned: (workspace: WorkspaceSummary) => void
  workspace: WorkspaceSummary
}

export const CloneWorkspaceDialog = ({
  open,
  onClose,
  onCloned,
  workspace,
}: CloneWorkspaceDialogProps) => {
  const { t } = useI18n()
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [createBranch, setCreateBranch] = useState(true)
  const [copyTasks, setCopyTasks] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const derivedName = name.trim() || `${workspace.name}-${branch.trim().replace(/\//g, '-')}`

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedBranch = branch.trim()
    if (!trimmedBranch) return
    setSubmitting(true)
    setError(null)
    try {
      const trimmedName = name.trim()
      const created = await cloneWorkspace(workspace.id, {
        branch: trimmedBranch,
        ...(trimmedName ? { name: trimmedName } : {}),
        create_branch: createBranch,
        copy_tasks: copyTasks,
      })
      onCloned(created)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[440px] max-w-full flex-col rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <form onSubmit={handleSubmit} className="flex flex-col">
              <div
                className="flex shrink-0 flex-col gap-0.5 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('cloneWorkspace.title')}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-ter">
                  {t('cloneWorkspace.description', { name: workspace.name })}
                </Dialog.Description>
              </div>

              <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-sec">
                    {t('cloneWorkspace.branch')}
                  </span>
                  <input
                    // biome-ignore lint/a11y/noAutofocus: dialog is user-initiated
                    autoFocus
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="feature/my-branch"
                    className="input"
                    required
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-sec">
                    {t('cloneWorkspace.name')}
                  </span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={derivedName}
                    className="input"
                  />
                  <span className="text-xs text-ter">
                    {t('cloneWorkspace.nameHint')}
                  </span>
                </label>

                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-pri">
                    <input
                      type="checkbox"
                      checked={createBranch}
                      onChange={(e) => setCreateBranch(e.target.checked)}
                    />
                    {t('cloneWorkspace.createBranch')}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-pri">
                    <input
                      type="checkbox"
                      checked={copyTasks}
                      onChange={(e) => setCopyTasks(e.target.checked)}
                    />
                    {t('cloneWorkspace.copyTasks')}
                  </label>
                </div>

                {error ? (
                  <p className="text-sm text-status-red">{error}</p>
                ) : null}
              </div>

              <div
                className="flex shrink-0 items-center justify-end gap-3 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded px-3 py-1.5 text-sm text-sec hover:bg-2"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={submitting || !branch.trim()}
                  className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
                >
                  {submitting ? t('cloneWorkspace.cloning') : t('cloneWorkspace.submit')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
