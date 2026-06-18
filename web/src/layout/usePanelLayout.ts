import { useCallback, useEffect, useRef, useState } from 'react'

export type PanelId = 'tasks' | 'workers' | 'terminal'

export interface PanelLayoutState {
  order: PanelId[]
  collapsed: Record<PanelId, boolean>
}

const DEFAULT_LAYOUT: PanelLayoutState = {
  order: ['tasks', 'workers', 'terminal'],
  collapsed: { tasks: false, workers: false, terminal: false },
}

const API_PATH = '/api/settings/app-state/panel_layout'

export const usePanelLayout = () => {
  const [layout, setLayout] = useState<PanelLayoutState>(DEFAULT_LAYOUT)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void fetch(API_PATH).then(async (res) => {
      if (!res.ok) return
      const payload = (await res.json()) as { key: string; value: PanelLayoutState | null }
      if (payload.value) setLayout(payload.value)
    }).catch(() => {})
  }, [])

  const persist = useCallback((next: PanelLayoutState) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void fetch(API_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: next }),
      }).catch(() => {})
    }, 300)
  }, [])

  const toggleCollapsed = useCallback((id: PanelId, force?: boolean) => {
    setLayout((prev) => {
      const value = force !== undefined ? force : !prev.collapsed[id]
      const next: PanelLayoutState = {
        ...prev,
        collapsed: { ...prev.collapsed, [id]: value },
      }
      persist(next)
      return next
    })
  }, [persist])

  const reorder = useCallback((newOrder: PanelId[]) => {
    setLayout((prev) => {
      const next: PanelLayoutState = { ...prev, order: newOrder }
      persist(next)
      return next
    })
  }, [persist])

  return { layout, toggleCollapsed, reorder }
}
