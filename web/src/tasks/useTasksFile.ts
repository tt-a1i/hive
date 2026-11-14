import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getApiTransport, getWorkspaceTasks, saveWorkspaceTasks } from '../api.js'
import type { TransportSocket } from '../transport/api-transport.js'
import {
  appendChildTaskAtLine,
  appendTaskToContent,
  deleteTaskLine,
  toggleTaskLine,
  updateTaskTextAtLine,
} from './task-markdown.js'

const shouldIgnoreRemoteUpdate = (
  nextContent: string,
  savedContent: string,
  currentContent: string
) => nextContent === savedContent || nextContent === currentContent

export const useTasksFile = (workspaceId: string | null, demoContent?: string) => {
  const scope = useMemo(() => ({ workspaceId }), [workspaceId])
  const currentScope = useRef<typeof scope | null>(scope)
  const editRevision = useRef(0)
  const saveRevision = useRef(0)
  const pendingSaveRef = useRef<Promise<{ content: string }> | null>(null)
  const [contentScope, setContentScope] = useState(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [remoteContent, setRemoteContent] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const contentRef = useRef('')

  const applyRemoteContent = useCallback((nextContent: string, currentContent: string) => {
    if (!dirtyRef.current) {
      saveRevision.current += 1
      savedContentRef.current = nextContent
      contentRef.current = nextContent
      editRevision.current += 1
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
      return
    }
    if (shouldIgnoreRemoteUpdate(nextContent, savedContentRef.current, currentContent)) {
      return
    }
    saveRevision.current += 1
    editRevision.current += 1
    setRemoteContent(nextContent)
    setHasConflict(true)
  }, [])

  useEffect(() => {
    setContentScope(scope)
    pendingSaveRef.current = null
    if (!workspaceId) {
      setContent('')
      setLoaded(false)
      setHasConflict(false)
      setRemoteContent(null)
      dirtyRef.current = false
      savedContentRef.current = ''
      contentRef.current = ''
      return
    }
    let cancelled = false
    setContent('')
    setLoaded(false)
    setHasConflict(false)
    setRemoteContent(null)
    dirtyRef.current = false
    savedContentRef.current = ''
    contentRef.current = ''
    const initialRevision = editRevision.current
    void getWorkspaceTasks(workspaceId)
      .then(({ content: nextContent }) => {
        if (cancelled || currentScope.current !== scope) return
        setLoaded(true)
        if (editRevision.current !== initialRevision) return
        editRevision.current += 1
        savedContentRef.current = nextContent
        dirtyRef.current = false
        contentRef.current = nextContent
        setContent(nextContent)
        setHasConflict(false)
        setRemoteContent(null)
      })
      .catch((error: unknown) => {
        if (cancelled || currentScope.current !== scope) return
        setLoaded(true)
        if (editRevision.current !== initialRevision) return
        savedContentRef.current = ''
        dirtyRef.current = false
        contentRef.current = ''
        setContent('')
        setHasConflict(false)
        console.error('[hive] swallowed:tasks.initialLoad', error)
        setRemoteContent(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, scope])

  useEffect(() => {
    if (!workspaceId) return
    let closed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    // Track the live socket so cleanup can close it even when the ref lives in openSocket's scope.
    let activeSocket: TransportSocket | null = null

    const openSocket = (): void => {
      if (closed || currentScope.current !== scope) return
      const openedAtRevision = editRevision.current
      const socket = getApiTransport().openWebSocket(`/ws/tasks/${workspaceId}`)
      activeSocket = socket
      const isActive = () => !closed && currentScope.current === scope && activeSocket === socket
      const refreshSnapshot = async () => {
        try {
          while (isActive()) {
            // A snapshot may predate an optimistic write. Read again after that write settles.
            await pendingSaveRef.current?.catch(() => undefined)
            if (!isActive()) return
            const revision = editRevision.current
            const latest = await getWorkspaceTasks(workspaceId)
            if (!isActive()) return
            // An edit, save acknowledgement or live update overtook this read.
            if (editRevision.current !== revision || pendingSaveRef.current !== null) continue
            applyRemoteContent(latest.content, contentRef.current)
            return
          }
        } catch (error) {
          if (isActive()) console.error('[hive] swallowed:tasks.refreshSnapshot', error)
        }
      }
      socket.onmessage = (event) => {
        if (closed || currentScope.current !== scope) return
        // The tasks channel is text-only (JSON snapshots); coerce since the transport socket's
        // message type is the broader string | binary union.
        const payload = JSON.parse(String(event.data)) as { content?: string; type: string }
        if (payload.type !== 'tasks-snapshot' && payload.type !== 'tasks-updated') return
        if (typeof payload.content !== 'string') return
        attempt = 0
        if (
          payload.type === 'tasks-snapshot' &&
          (editRevision.current !== openedAtRevision || pendingSaveRef.current !== null)
        ) {
          void refreshSnapshot()
          return
        }
        applyRemoteContent(payload.content, contentRef.current)
      }
      socket.onclose = () => {
        if (closed || currentScope.current !== scope) return
        // Capped exponential backoff: 500ms, 1s, 2s, 4s … up to 30s.
        attempt += 1
        const delay = Math.min(30_000, 500 * 2 ** (attempt - 1))
        retryTimer = setTimeout(openSocket, delay)
      }
    }

    openSocket()
    return () => {
      closed = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      activeSocket?.close()
    }
  }, [applyRemoteContent, workspaceId, scope])

  // Demo short-circuit: all hooks have run above; now return static fixture data.
  // workspaceId is null when demoContent is provided, so no server calls were made.
  if (demoContent !== undefined) {
    return {
      content: demoContent,
      hasConflict: false,
      loaded: true,
      onChange: (_value: string) => {},
      onKeepLocal: () => {},
      onReload: () => {},
      onSave: async () => {},
      toggleTaskAtLine: async (_lineIndex: number) => {},
      appendTask: async (_text: string) => {},
      appendSubtask: async (_parentLine: number, _text: string) => {},
      updateTaskText: async (_lineIndex: number, _nextText: string) => {},
      deleteTask: async (_lineIndex: number) => {},
    }
  }

  const isCurrent = () => currentScope.current === scope
  const saveContent = async (next: string, previous?: { content: string; saved: string }) => {
    if (!workspaceId || !isCurrent()) return
    const request = ++saveRevision.current
    const revision = editRevision.current
    const pendingSave = saveWorkspaceTasks(workspaceId, { content: next })
    pendingSaveRef.current = pendingSave
    try {
      const response = await pendingSave
      if (!isCurrent() || request !== saveRevision.current) return
      savedContentRef.current = response.content
      if (editRevision.current === revision) {
        contentRef.current = response.content
        dirtyRef.current = false
        setContent(response.content)
        setHasConflict(false)
        setRemoteContent(null)
      } else dirtyRef.current = contentRef.current !== response.content
      editRevision.current += 1
    } catch (error) {
      if (!isCurrent()) return
      if (request === saveRevision.current && previous !== undefined) {
        savedContentRef.current = previous.saved
        if (editRevision.current === revision) {
          contentRef.current = previous.content
          setContent(previous.content)
        }
        dirtyRef.current = contentRef.current !== previous.saved
        editRevision.current += 1
      }
      throw error
    } finally {
      if (pendingSaveRef.current === pendingSave) pendingSaveRef.current = null
    }
  }
  const persistTransform = async (
    transform: (current: string) => string,
    operationLabel: string
  ) => {
    if (!workspaceId || !isCurrent()) return
    const previous = contentRef.current
    const previousSaved = savedContentRef.current
    const next = transform(previous)
    if (next === previous) return
    savedContentRef.current = next
    contentRef.current = next
    editRevision.current += 1
    dirtyRef.current = false
    setContent(next)
    try {
      await saveContent(next, { content: previous, saved: previousSaved })
    } catch (error) {
      console.error(`[hive] swallowed:tasks.${operationLabel}`, error)
      throw error
    }
  }
  return {
    content: contentScope === scope ? content : '',
    hasConflict: contentScope === scope && hasConflict,
    loaded: contentScope === scope && loaded,
    onChange: (value: string) => {
      if (!isCurrent()) return
      editRevision.current += 1
      dirtyRef.current = value !== savedContentRef.current
      contentRef.current = value
      setContent(value)
    },
    onKeepLocal: () => {
      if (isCurrent()) {
        setHasConflict(false)
        setRemoteContent(null)
      }
    },
    onReload: () => {
      if (!isCurrent()) return
      const nextContent = remoteContent ?? savedContentRef.current
      saveRevision.current += 1
      editRevision.current += 1
      savedContentRef.current = nextContent
      dirtyRef.current = false
      contentRef.current = nextContent
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
    },
    onSave: async () => {
      await saveContent(contentRef.current)
    },
    toggleTaskAtLine: async (lineIndex: number) => {
      await persistTransform((current) => toggleTaskLine(current, lineIndex), 'toggleTask')
    },
    appendTask: async (text: string) => {
      const trimmed = text.trim()
      if (trimmed)
        await persistTransform((current) => appendTaskToContent(current, trimmed), 'appendTask')
    },
    appendSubtask: async (parentLine: number, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => appendChildTaskAtLine(current, parentLine, trimmed),
        'appendSubtask'
      )
    },
    updateTaskText: async (lineIndex: number, nextText: string) => {
      const trimmed = nextText.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => updateTaskTextAtLine(current, lineIndex, trimmed),
        'updateTaskText'
      )
    },
    deleteTask: async (lineIndex: number) => {
      await persistTransform((current) => deleteTaskLine(current, lineIndex), 'deleteTask')
    },
  }
}
