import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type ToastKind = 'success' | 'warning' | 'error'

export interface ToastEntry {
  id: string
  kind: ToastKind
  message: string
}

interface ShowOptions {
  kind: ToastKind
  message: string
  /** ms; defaults: success=3000, warning=5000, error=0 (sticky). 0 = never auto-close */
  durationMs?: number
}

/**
 * Stable API surface — show/dismiss callbacks are useCallback-bound and the
 * api object itself is useMemo'd, so consumers depending on it inside
 * useEffect() do not re-run when the toast list changes.
 *
 * Toast state (the list) lives in a separate context (ToastStateContext) so
 * only the Toaster subscribes to it; consumers that only push toasts (the
 * common case) are not affected by list churn.
 */
interface ToastApi {
  show: (opts: ShowOptions) => string
  dismiss: (id: string) => void
}

const ToastApiContext = createContext<ToastApi | null>(null)
const ToastStateContext = createContext<ToastEntry[]>([])

/** Hard cap on simultaneous toasts to avoid DOM ballooning under failure storms. */
const MAX_TOASTS = 3

const defaultDuration = (kind: ToastKind): number => {
  if (kind === 'success') return 3000
  if (kind === 'warning') return 5000
  return 0
}

// Module-level monotonic counter. Toast ids live only inside the current page
// session — collisions across page loads would still be uniquely-keyed by the
// Date.now() suffix. Using a counter sidesteps the AGENTS.md §6 ban on
// Math.random for ids and does not depend on a secure context the way
// crypto.randomUUID does.
let toastIdCounter = 0
const generateId = (): string => {
  toastIdCounter += 1
  return `t-${toastIdCounter.toString(36)}-${Date.now().toString(36)}`
}

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    ({ kind, message, durationMs }: ShowOptions): string => {
      const id = generateId()
      setToasts((current) => {
        const next = [...current, { id, kind, message }]
        if (next.length <= MAX_TOASTS) return next
        // Over cap: drop oldest entries AND clear their pending dismiss timers
        // so they don't leak in timers.current until natural expiry.
        const evicted = next.slice(0, next.length - MAX_TOASTS)
        for (const entry of evicted) {
          const timer = timers.current.get(entry.id)
          if (timer) {
            clearTimeout(timer)
            timers.current.delete(entry.id)
          }
        }
        return next.slice(next.length - MAX_TOASTS)
      })
      const ms = durationMs ?? defaultDuration(kind)
      if (ms > 0) {
        const timer = setTimeout(() => dismiss(id), ms)
        timers.current.set(id, timer)
      }
      return id
    },
    [dismiss]
  )

  useEffect(() => {
    const timersAtMount = timers.current
    return () => {
      for (const timer of timersAtMount.values()) clearTimeout(timer)
      timersAtMount.clear()
    }
  }, [])

  // Stable api ref — show/dismiss are useCallback-bound, so the memo only
  // changes when those identities change (i.e. never, after first mount).
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastApiContext.Provider value={api}>
      <ToastStateContext.Provider value={toasts}>{children}</ToastStateContext.Provider>
    </ToastApiContext.Provider>
  )
}

/** Push toasts. Stable across renders — safe in useEffect deps. */
export const useToast = (): ToastApi => {
  const ctx = useContext(ToastApiContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

/** Subscribe to the toast list. Use only in <Toaster />. */
export const useToastList = (): ToastEntry[] => useContext(ToastStateContext)
