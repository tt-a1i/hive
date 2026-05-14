import { X } from 'lucide-react'

import type { ToastKind } from './useToast.js'
import { useToast, useToastList } from './useToast.js'

const dotClassByKind: Record<ToastKind, string> = {
  success: 'status-dot status-dot--working',
  warning: 'status-dot status-dot--queued',
  error: 'status-dot status-dot--stopped',
}

const accentByKind: Record<ToastKind, string> = {
  success: 'var(--status-green)',
  warning: 'var(--status-orange)',
  error: 'var(--status-red)',
}

export const Toaster = () => {
  const toasts = useToastList()
  const { dismiss, pauseDismiss, resumeDismiss, getDuration } = useToast()
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-8 z-50 flex flex-col gap-2"
      data-testid="toaster"
    >
      {toasts.map((toast) => {
        const duration = getDuration(toast.id)
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: the mouse handlers pause the dismiss timer without making the toast itself interactive (the X button is the real interactive surface)
          <div
            key={toast.id}
            data-testid="toast"
            data-kind={toast.kind}
            onMouseEnter={() => pauseDismiss(toast.id)}
            onMouseLeave={() => resumeDismiss(toast.id)}
            className="toast elev-2 toast-pop pointer-events-auto relative flex min-w-[260px] max-w-[400px] items-start gap-3 overflow-hidden rounded-lg border px-3 py-2.5"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: `color-mix(in oklab, ${accentByKind[toast.kind]} 35%, var(--border))`,
            }}
          >
            <span className={`mt-1 ${dotClassByKind[toast.kind]}`} aria-hidden />
            <div className="min-w-0 flex-1 break-words text-sm text-pri">{toast.message}</div>
            <button
              type="button"
              data-testid="toast-close"
              onClick={() => dismiss(toast.id)}
              className="-mt-0.5 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ter transition-colors hover:bg-3 hover:text-pri"
              aria-label="Dismiss"
            >
              <X size={14} aria-hidden />
            </button>
            {duration > 0 ? (
              <span
                className="toast-progress-bar"
                style={
                  {
                    background: accentByKind[toast.kind],
                    animationDuration: `${duration}ms`,
                  } as React.CSSProperties
                }
                aria-hidden
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
