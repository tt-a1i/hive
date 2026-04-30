import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, HelpCircle } from 'lucide-react'

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
  cancelLabel = 'Cancel',
  onConfirm,
}: ConfirmProps) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay data-testid="confirm-overlay" className="app-overlay fixed inset-0 z-40" />
      <Dialog.Content
        data-testid="confirm-content"
        className="dialog-pop elev-2 fixed top-1/2 left-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-bright)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: `color-mix(in oklab, ${iconColor(confirmKind)} 14%, transparent)`,
              color: iconColor(confirmKind),
              border: `1px solid color-mix(in oklab, ${iconColor(confirmKind)} 30%, transparent)`,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            }}
          >
            {confirmKind === 'danger' ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <Dialog.Title data-testid="confirm-title" className="text-md font-medium text-pri">
              {title}
            </Dialog.Title>
            <Dialog.Description
              data-testid="confirm-description"
              className="mt-1.5 text-sm leading-relaxed text-sec"
            >
              {description}
            </Dialog.Description>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={() => onOpenChange(false)}
            className="icon-btn"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid="confirm-action"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
            className={
              confirmKind === 'danger' ? 'icon-btn icon-btn--danger' : 'icon-btn icon-btn--primary'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)
