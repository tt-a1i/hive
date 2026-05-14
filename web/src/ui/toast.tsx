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
          className="elev-2 toast-pop pointer-events-auto flex min-w-[260px] max-w-[400px] items-start gap-3 rounded-lg border px-3 py-2.5"
          style={{
            background: 'var(--bg-elevated)',
            borderColor: `color-mix(in oklab, ${accentByKind[toast.kind]} 35%, var(--border))`,
          }}
        >
          <span className={`mt-1 ${dotClassByKind[toast.kind]}`} aria-hidden />
          <div className="min-w-0 flex-1 break-words text-sm leading-relaxed text-pri">
            {toast.message}
          </div>
          <button
            type="button"
            data-testid="toast-close"
            onClick={() => dismiss(toast.id)}
            className="-mt-0.5 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ter transition-colors hover:bg-3 hover:text-pri"
            aria-label="Dismiss"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
