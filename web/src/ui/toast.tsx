import { useToast, useToastList } from './useToast.js'

export const Toaster = () => {
  const toasts = useToastList()
  const { dismiss } = useToast()
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-8 z-50 flex flex-col gap-2"
      data-testid="toaster"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          data-kind={toast.kind}
          className="pointer-events-auto flex min-w-[260px] max-w-[400px] items-start gap-3 rounded-lg border px-3 py-2"
          style={{
            background: 'var(--bg-elevated)',
            borderColor:
              toast.kind === 'error'
                ? 'color-mix(in oklab, var(--status-red) 35%, var(--border))'
                : toast.kind === 'warning'
                  ? 'color-mix(in oklab, var(--status-orange) 35%, var(--border))'
                  : 'color-mix(in oklab, var(--status-green) 35%, var(--border))',
            boxShadow: 'var(--shadow-elev-2)',
          }}
        >
          <span
            className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
            style={{
              background:
                toast.kind === 'error'
                  ? 'var(--status-red)'
                  : toast.kind === 'warning'
                    ? 'var(--status-orange)'
                    : 'var(--status-green)',
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1 break-words text-sm text-pri">{toast.message}</div>
          <button
            type="button"
            data-testid="toast-close"
            onClick={() => dismiss(toast.id)}
            className="rounded p-0.5 text-ter hover:text-pri"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
