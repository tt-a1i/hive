import { useEffect, useState } from 'react'
import type { ActionCenterConversation } from '../../../src/shared/action-center.js'
import { getDispatchMessageHistory } from '../api.js'

const isPageHidden = () => document.visibilityState === 'hidden'

export interface MessageSelection {
  dispatchId: string
  cursor?: { afterMessageId?: string; beforeMessageId?: string; aroundMessageId?: string }
  focus?: 'first' | 'last' | { messageId: string }
}

/** Keep one bounded window live; navigation owns focus, polling only updates data. */
export const useActionCenterConversation = (
  workspaceId: string,
  selection: MessageSelection | null
) => {
  const [state, setState] = useState<{
    workspaceId: string
    selection: MessageSelection
    page: ActionCenterConversation | null
    error: boolean
  } | null>(null)

  useEffect(() => {
    if (!selection) return
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setState({ workspaceId, selection, page: null, error: false })

    const tick = async () => {
      if (cancelled || inFlight || isPageHidden()) return
      inFlight = true
      const request = new AbortController()
      controller = request
      try {
        const page = await getDispatchMessageHistory(
          workspaceId,
          selection.dispatchId,
          selection.cursor,
          request.signal
        )
        if (!cancelled && !request.signal.aborted) {
          setState({ workspaceId, selection, page, error: false })
        }
      } catch {
        if (!cancelled && !request.signal.aborted) {
          setState((previous) => ({
            workspaceId,
            selection,
            page: previous?.selection === selection ? previous.page : null,
            error: true,
          }))
        }
      } finally {
        inFlight = false
        if (controller === request) controller = undefined
        if (!cancelled && !isPageHidden()) {
          timer = setTimeout(tick, request.signal.aborted ? 0 : 2000)
        }
      }
    }
    const handleVisibility = () => {
      clearTimeout(timer)
      if (isPageHidden()) controller?.abort()
      else void tick()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [workspaceId, selection])

  return state?.workspaceId === workspaceId && state.selection === selection ? state : null
}
