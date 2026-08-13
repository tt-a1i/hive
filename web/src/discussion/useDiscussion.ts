import { useCallback, useEffect, useRef, useState } from 'react'

import {
  endDiscussion as apiEndDiscussion,
  fetchDiscussionTimeline,
  getActiveDiscussions,
  getDiscussionMessages,
  startDiscussion as apiStartDiscussion,
  type StartDiscussionInput,
  type TimelineEvent,
} from './api.js'
import type { DiscussionGroup, DiscussionMessage } from './types.js'

const POLL_INTERVAL_MS = 2000

export interface UseDiscussionResult {
  activeGroup: DiscussionGroup | null
  displayGroup: DiscussionGroup | null
  allGroups: DiscussionGroup[]
  messages: DiscussionMessage[]
  timelineEvents: TimelineEvent[]
  loading: boolean
  error: string | null
  startDiscussion: (input: StartDiscussionInput) => Promise<void>
  endDiscussion: (reason?: string) => Promise<void>
  refresh: () => void
}

export const useDiscussion = (workspaceId: string | null): UseDiscussionResult => {
  const [allGroups, setAllGroups] = useState<DiscussionGroup[]>([])
  const [messages, setMessages] = useState<DiscussionMessage[]>([])
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  const fetchState = useCallback(async () => {
    if (!workspaceId) return
    try {
      const groups = await getActiveDiscussions(workspaceId)
      if (!mountedRef.current) return
      setAllGroups(groups)
      setError(null)

      const active = groups.find(
        (g) => g.status === 'thinking' || g.status === 'discussing' || g.status === 'concluding'
      )
      if (active) {
        const msgs = await getDiscussionMessages(workspaceId, active.id)
        if (!mountedRef.current) return
        setMessages(msgs)
        setTimelineEvents([])
      } else {
        const concluded = groups.find((g) => g.status === 'concluded')
        if (concluded) {
          const [msgs, timeline] = await Promise.all([
            getDiscussionMessages(workspaceId, concluded.id),
            fetchDiscussionTimeline(workspaceId, concluded.id),
          ])
          if (!mountedRef.current) return
          setMessages(msgs)
          setTimelineEvents(timeline.events)
        } else {
          setMessages([])
          setTimelineEvents([])
        }
      }
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [workspaceId])

  useEffect(() => {
    mountedRef.current = true
    if (!workspaceId) return
    fetchState()
    timerRef.current = setInterval(fetchState, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [workspaceId, fetchState])

  const activeGroup =
    allGroups.find(
      (g) => g.status === 'thinking' || g.status === 'discussing' || g.status === 'concluding'
    ) ?? null

  const displayGroup = activeGroup ?? allGroups.find((g) => g.status === 'concluded') ?? null

  const startDiscussion = useCallback(
    async (input: StartDiscussionInput) => {
      if (!workspaceId) return
      setLoading(true)
      try {
        await apiStartDiscussion(workspaceId, input)
        await fetchState()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start discussion')
      } finally {
        setLoading(false)
      }
    },
    [workspaceId, fetchState]
  )

  const endDiscussion = useCallback(
    async (reason?: string) => {
      if (!workspaceId || !activeGroup) return
      setLoading(true)
      try {
        await apiEndDiscussion(workspaceId, activeGroup.id, reason)
        await fetchState()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to end discussion')
      } finally {
        setLoading(false)
      }
    },
    [workspaceId, activeGroup, fetchState]
  )

  return {
    activeGroup,
    displayGroup,
    allGroups,
    messages,
    timelineEvents,
    loading,
    error,
    startDiscussion,
    endDiscussion,
    refresh: fetchState,
  }
}
