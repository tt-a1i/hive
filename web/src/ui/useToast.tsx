import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

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

interface ToastApi {
  show: (opts: ShowOptions) => string
  dismiss: (id: string) => void
  toasts: ToastEntry[]
}

const ToastContext = createContext<ToastApi | null>(null)

const defaultDuration = (kind: ToastKind): number => {
  if (kind === 'success') return 3000
  if (kind === 'warning') return 5000
  return 0
}

const generateId = () => `t-${crypto.randomUUID().slice(0, 8)}-${Date.now().toString(36)}`

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
      setToasts((current) => [...current, { id, kind, message }])
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

  return <ToastContext.Provider value={{ show, dismiss, toasts }}>{children}</ToastContext.Provider>
}

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
