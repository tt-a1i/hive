import * as Dialog from '@radix-ui/react-dialog'

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
        className="elev-2 fixed top-1/2 left-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-bright)',
        }}
      >
        <Dialog.Title data-testid="confirm-title" className="text-md font-medium text-pri">
          {title}
        </Dialog.Title>
        <Dialog.Description data-testid="confirm-description" className="mt-2 text-sm text-sec">
          {description}
        </Dialog.Description>
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
