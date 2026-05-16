import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, HelpCircle } from 'lucide-react'

import { useI18n } from '../i18n.js'

type ConfirmKind = 'default' | 'danger'

type ConfirmProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  confirmKind?: ConfirmKind
  cancelLabel?: string
  onConfirm: () => void
}

const iconColor = (kind: ConfirmKind) => (kind === 'danger' ? 'var(--status-red)' : 'var(--accent)')

export const Confirm = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmKind = 'default',
  cancelLabel,
  onConfirm,
}: ConfirmProps) => {
  const { t } = useI18n()
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel')
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="confirm-overlay" className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="confirm-content"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div className="flex items-start gap-3">
              <div
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: `color-mix(in oklab, ${iconColor(confirmKind)} 14%, transparent)`,
                  color: iconColor(confirmKind),
                  border: `1px solid color-mix(in oklab, ${iconColor(confirmKind)} 30%, transparent)`,
                }}
              >
                {confirmKind === 'danger' ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title
                  data-testid="confirm-title"
                  className="text-lg font-semibold text-pri"
                >
                  {title}
                </Dialog.Title>
                <Dialog.Description
                  data-testid="confirm-description"
                  className="mt-1.5 text-sm text-sec"
                >
                  {description}
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              {/* Destructive intent: focus Cancel by default so Enter does the
                safe thing. Non-destructive (and informational): focus the
                primary so Enter confirms — matches OS dialog conventions. */}
              <button
                type="button"
                data-testid="confirm-cancel"
                onClick={() => onOpenChange(false)}
                // biome-ignore lint/a11y/noAutofocus: dialog is opt-in and short-lived; safe-default focus on destructive Cancel
                autoFocus={confirmKind === 'danger'}
                className="icon-btn"
              >
                {resolvedCancelLabel}
              </button>
              <button
                type="button"
                data-testid="confirm-action"
                onClick={() => {
                  onConfirm()
                  onOpenChange(false)
                }}
                // biome-ignore lint/a11y/noAutofocus: dialog is opt-in and short-lived; primary action focus for non-destructive confirms
                autoFocus={confirmKind !== 'danger'}
                className={
                  confirmKind === 'danger'
                    ? 'icon-btn icon-btn--danger-solid'
                    : 'icon-btn icon-btn--primary'
                }
              >
                {confirmLabel}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
