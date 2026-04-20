import { useCallback, useEffect, useRef, useState } from 'react'

import { getWorkspaceTasks, saveWorkspaceTasks } from '../api.js'

const toTasksSocketUrl = (workspaceId: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/tasks/${workspaceId}`
}

const shouldIgnoreRemoteUpdate = (
  nextContent: string,
  savedContent: string,
  currentContent: string
) => nextContent === savedContent || nextContent === currentContent

export const useTasksFile = (workspaceId: string | null) => {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [remoteContent, setRemoteContent] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const contentRef = useRef('')

  const applyRemoteContent = useCallback((nextContent: string, currentContent: string) => {
    if (!dirtyRef.current) {
      savedContentRef.current = nextContent
      contentRef.current = nextContent
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
      return
    }
    if (shouldIgnoreRemoteUpdate(nextContent, savedContentRef.current, currentContent)) {
      return
    }
    setRemoteContent(nextContent)
    setHasConflict(true)
  }, [])

  useEffect(() => {
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
    void getWorkspaceTasks(workspaceId)
      .then(({ content: nextContent }) => {
        if (cancelled) return
        savedContentRef.current = nextContent
        dirtyRef.current = false
        contentRef.current = nextContent
        setContent(nextContent)
        setLoaded(true)
        setHasConflict(false)
        setRemoteContent(null)
      })
      .catch(() => {
        if (cancelled) return
        savedContentRef.current = ''
        dirtyRef.current = false
        contentRef.current = ''
        setContent('')
        setLoaded(true)
        setHasConflict(false)
        setRemoteContent(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let closed = false
    const socket = new WebSocket(toTasksSocketUrl(workspaceId))
    socket.onopen = () => {
      void getWorkspaceTasks(workspaceId)
        .then(({ content: nextContent }) => {
          if (!closed) applyRemoteContent(nextContent, contentRef.current)
        })
        .catch(() => {})
    }
    socket.onmessage = (event) => {
      if (closed) return
      const payload = JSON.parse(event.data) as { content: string; type: string }
      if (payload.type !== 'tasks-updated') return
      applyRemoteContent(payload.content, contentRef.current)
    }
    return () => {
      closed = true
      socket.close()
    }
  }, [applyRemoteContent, workspaceId])

  return {
    content,
    hasConflict,
    loaded,
    onChange: (value: string) => {
      dirtyRef.current = value !== savedContentRef.current
      contentRef.current = value
      setContent(value)
    },
    onKeepLocal: () => {
      setHasConflict(false)
      setRemoteContent(null)
    },
    onReload: () => {
      const nextContent = remoteContent ?? savedContentRef.current
      savedContentRef.current = nextContent
      dirtyRef.current = false
      contentRef.current = nextContent
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
    },
    onSave: async () => {
      if (!workspaceId) return
      const response = await saveWorkspaceTasks(workspaceId, { content })
      savedContentRef.current = response.content
      dirtyRef.current = false
      contentRef.current = response.content
      setContent(response.content)
      setHasConflict(false)
      setRemoteContent(null)
    },
  }
}
