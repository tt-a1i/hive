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
  /** Pause the auto-dismiss timer for a toast (e.g., while the user is
   *  hovering it). Safe to call on a toast with no timer — a no-op. */
  pauseDismiss: (id: string) => void
  /** Resume a previously-paused timer using the remaining duration. */
  resumeDismiss: (id: string) => void
  /** Read the total configured duration for a toast (used by the UI to
   *  size the progress bar). Returns 0 for sticky toasts. */
  getDuration: (id: string) => number
}

interface ToastTimer {
  timer: ReturnType<typeof setTimeout> | null
  dueAt: number
  durationMs: number
  remainingMs: number
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
  const timers = useRef(new Map<string, ToastTimer>())

  const clearTimer = useCallback((id: string) => {
    const entry = timers.current.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    timers.current.delete(id)
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
      clearTimer(id)
    },
    [clearTimer]
  )

  const show = useCallback(
    ({ kind, message, durationMs }: ShowOptions): string => {
      const id = generateId()
      setToasts((current) => {
        const next = [...current, { id, kind, message }]
        if (next.length <= MAX_TOASTS) return next
        // Over cap: drop oldest entries AND clear their pending dismiss timers
        // so they don't leak in timers.current until natural expiry.
        const evicted = next.slice(0, next.length - MAX_TOASTS)
        for (const entry of evicted) clearTimer(entry.id)
        return next.slice(next.length - MAX_TOASTS)
      })
      const ms = durationMs ?? defaultDuration(kind)
      if (ms > 0) {
        const timer = setTimeout(() => dismiss(id), ms)
        timers.current.set(id, {
          timer,
          dueAt: Date.now() + ms,
          durationMs: ms,
          remainingMs: ms,
        })
      }
      return id
    },
    [dismiss, clearTimer]
  )

  const pauseDismiss = useCallback((id: string) => {
    const entry = timers.current.get(id)
    if (!entry?.timer) return
    clearTimeout(entry.timer)
    timers.current.set(id, {
      ...entry,
      timer: null,
      remainingMs: Math.max(0, entry.dueAt - Date.now()),
    })
  }, [])

  const resumeDismiss = useCallback(
    (id: string) => {
      const entry = timers.current.get(id)
      if (!entry || entry.timer || entry.remainingMs <= 0) return
      const timer = setTimeout(() => dismiss(id), entry.remainingMs)
      timers.current.set(id, {
        ...entry,
        timer,
        dueAt: Date.now() + entry.remainingMs,
      })
    },
    [dismiss]
  )

  const getDuration = useCallback((id: string) => timers.current.get(id)?.durationMs ?? 0, [])

  useEffect(() => {
    const timersAtMount = timers.current
    return () => {
      for (const entry of timersAtMount.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      timersAtMount.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({ show, dismiss, pauseDismiss, resumeDismiss, getDuration }),
    [show, dismiss, pauseDismiss, resumeDismiss, getDuration]
  )

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
