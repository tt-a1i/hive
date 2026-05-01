import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'hive.split.orch-pct'
const MIN_PCT = 0.3
const MAX_PCT = 0.78
const DEFAULT_PCT = 0.6
const KEY_STEP = 0.02

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

const readStored = (): number => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PCT
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? clamp(n, MIN_PCT, MAX_PCT) : DEFAULT_PCT
  } catch {
    return DEFAULT_PCT
  }
}

/**
 * Drives a draggable splitter between OrchestratorPane and WorkersPane.
 * State is the orchestrator pane's share (0–1) of the container width;
 * persisted to localStorage so layout sticks across reloads.
 */
export const usePaneSplit = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [orchPct, setOrchPct] = useState<number>(() => readStored())
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, orchPct.toFixed(4))
    } catch {
      // localStorage unavailable (private mode, quota) — degrade silently.
    }
  }, [orchPct])

  const beginDrag = useCallback((startEvent: React.PointerEvent<HTMLDivElement>) => {
    startEvent.preventDefault()
    const container = containerRef.current
    if (!container) return
    setDragging(true)

    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const handleMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0) return
      const pct = (ev.clientX - rect.left) / rect.width
      setOrchPct(clamp(pct, MIN_PCT, MAX_PCT))
    }
    const handleUp = () => {
      setDragging(false)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleUp)
    }
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setOrchPct((p) => clamp(p - KEY_STEP, MIN_PCT, MAX_PCT))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setOrchPct((p) => clamp(p + KEY_STEP, MIN_PCT, MAX_PCT))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setOrchPct(MIN_PCT)
    } else if (e.key === 'End') {
      e.preventDefault()
      setOrchPct(MAX_PCT)
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // ⌘+Enter to reset to default (small power-user touch).
      e.preventDefault()
      setOrchPct(DEFAULT_PCT)
    }
  }, [])

  return { containerRef, orchPct, dragging, beginDrag, onKeyDown }
}
