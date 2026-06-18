import { useCallback, useEffect, useRef, useState } from 'react'

export type DispatchStatus = 'queued' | 'submitted' | 'reported' | 'cancelled'

export interface DispatchItem {
  id: string
  state: DispatchStatus
  task_id: string | null
  text: string
  to_agent_id: string
  from_agent_id: string | null
  created_at: number
  reported_at: number | null
  report_text: string | null
}

export interface TaskDispatchSummary {
  taskId: string | null
  total: number
  reported: number
  cancelled: number
  failed: number
  allDone: boolean
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response
}

export const fetchDispatches = async (
  workspaceId: string,
  state?: DispatchStatus
): Promise<DispatchItem[]> => {
  const params = new URLSearchParams()
  if (state) params.set('state', state)
  params.set('limit', '100')
  const url = `/api/ui/workspaces/${workspaceId}/dispatches?${params}`
  const response = await apiFetch(url)
  return (await response.json()) as DispatchItem[]
}

export const groupDispatchesByTaskId = (dispatches: DispatchItem[]): Map<string | null, TaskDispatchSummary> => {
  const map = new Map<string | null, TaskDispatchSummary>()
  for (const d of dispatches) {
    const key = d.task_id
    const existing = map.get(key)
    if (existing) {
      existing.total++
      if (d.state === 'reported') existing.reported++
      if (d.state === 'cancelled') existing.cancelled++
      existing.allDone = existing.reported + existing.cancelled === existing.total
    } else {
      const reported = d.state === 'reported' ? 1 : 0
      const cancelled = d.state === 'cancelled' ? 1 : 0
      map.set(key, {
        taskId: key,
        total: 1,
        reported,
        cancelled,
        failed: 0,
        allDone: reported + cancelled === 1,
      })
    }
  }
  return map
}

export const useDispatchesForWorkspace = (workspaceId: string | null) => {
  const [dispatches, setDispatches] = useState<DispatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    try {
      const data = await fetchDispatches(workspaceId)
      setDispatches(data)
    } catch (error) {
      console.error('[hive] swallowed:useTasksApi.refresh', error)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      setDispatches([])
      return
    }
    setLoading(true)
    void refresh().finally(() => setLoading(false))
    intervalRef.current = setInterval(() => void refresh(), 5000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [workspaceId, refresh])

  return { dispatches, loading, refresh }
}

const HISTORY_PAGE_SIZE = 20

export const fetchDispatchHistory = async (
  workspaceId: string,
  limit = HISTORY_PAGE_SIZE,
  offset = 0
): Promise<DispatchItem[]> => {
  const [reported, cancelled] = await Promise.all([
    apiFetch(`/api/ui/workspaces/${workspaceId}/dispatches?state=reported&limit=${limit}&offset=${offset}`),
    apiFetch(`/api/ui/workspaces/${workspaceId}/dispatches?state=cancelled&limit=${limit}&offset=${offset}`),
  ])
  const [r, c] = await Promise.all([
    reported.json() as Promise<DispatchItem[]>,
    cancelled.json() as Promise<DispatchItem[]>,
  ])
  return [...r, ...c].sort((a, b) => (b.reported_at ?? b.created_at) - (a.reported_at ?? a.created_at))
}

export const useDispatchHistory = (workspaceId: string | null) => {
  const [items, setItems] = useState<DispatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const offsetRef = useRef(0)

  useEffect(() => {
    setItems([])
    offsetRef.current = 0
    setHasMore(true)
    if (!workspaceId) return
    setLoading(true)
    void fetchDispatchHistory(workspaceId).then((data) => {
      setItems(data)
      setHasMore(data.length >= HISTORY_PAGE_SIZE)
      offsetRef.current = HISTORY_PAGE_SIZE
    }).finally(() => setLoading(false))
  }, [workspaceId])

  const loadMore = useCallback(async () => {
    if (!workspaceId || loading) return
    setLoading(true)
    try {
      const data = await fetchDispatchHistory(workspaceId, HISTORY_PAGE_SIZE, offsetRef.current)
      setItems((prev) => [...prev, ...data])
      setHasMore(data.length >= HISTORY_PAGE_SIZE)
      offsetRef.current += HISTORY_PAGE_SIZE
    } finally {
      setLoading(false)
    }
  }, [workspaceId, loading])

  return { items, loading, hasMore, loadMore }
}
