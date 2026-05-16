import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react'
import type { ComponentType, CSSProperties } from 'react'

import { useI18n } from '../i18n.js'
import type { ToastEntry, ToastKind } from './useToast.js'
import { useToast, useToastList } from './useToast.js'

const iconByKind: Record<ToastKind, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
}

const accentByKind: Record<ToastKind, string> = {
  success: 'var(--status-green)',
  warning: 'var(--status-orange)',
  error: 'var(--status-red)',
}

type ToastApi = ReturnType<typeof useToast>

type ToastCardProps = {
  toast: ToastEntry
  api: ToastApi
}

const ToastCard = ({ toast, api }: ToastCardProps) => {
  const { t } = useI18n()
  const Icon = iconByKind[toast.kind]
  const duration = api.getDuration(toast.id)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the mouse handlers pause the dismiss timer without making the toast itself interactive (the X button is the real interactive surface)
    <div
      data-testid="toast"
      data-kind={toast.kind}
      onMouseEnter={() => api.pauseDismiss(toast.id)}
      onMouseLeave={() => api.resumeDismiss(toast.id)}
      className="toast elev-2 toast-pop pointer-events-auto relative flex min-w-[260px] max-w-[400px] items-start gap-3 overflow-hidden rounded-lg border px-3 py-2.5"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: `color-mix(in oklab, ${accentByKind[toast.kind]} 35%, var(--border))`,
      }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: accentByKind[toast.kind] }} aria-hidden>
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1 break-words text-sm text-pri">{toast.message}</div>
      <button
        type="button"
        data-testid="toast-close"
        onClick={() => api.dismiss(toast.id)}
        className="-mt-0.5 -mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-ter transition-colors hover:bg-3 hover:text-pri"
        aria-label={t('toast.dismissAria')}
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
            } as CSSProperties
          }
          aria-hidden
        />
      ) : null}
    </div>
  )
}

export const Toaster = () => {
  const toasts = useToastList()
  const api = useToast()
  if (toasts.length === 0) return null
  // Split severity: errors get role=alert + assistive-tech-interrupting
  // aria-live=assertive so they're announced immediately. Success/warning
  // stay polite (announced when AT is idle).
  const errorToasts = toasts.filter((t) => t.kind === 'error')
  const otherToasts = toasts.filter((t) => t.kind !== 'error')
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-8 z-50 flex flex-col gap-2"
      data-testid="toaster"
    >
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {otherToasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} api={api} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
        {errorToasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} api={api} />
        ))}
      </div>
    </div>
  )
}
