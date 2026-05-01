import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hive.workspace-sidebar.width'
export const WORKSPACE_SIDEBAR_MIN = 56
export const WORKSPACE_SIDEBAR_MAX = 384
const WORKSPACE_SIDEBAR_DEFAULT = 256
const KEYBOARD_STEP = 16

const clamp = (value: number): number =>
  Math.min(WORKSPACE_SIDEBAR_MAX, Math.max(WORKSPACE_SIDEBAR_MIN, value))

const readStoredWidth = (): number => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return WORKSPACE_SIDEBAR_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : WORKSPACE_SIDEBAR_DEFAULT
  } catch {
    return WORKSPACE_SIDEBAR_DEFAULT
  }
}

export const useWorkspaceSidebarResize = () => {
  const [width, setWidth] = useState(readStoredWidth)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(width)))
    } catch {
      // localStorage can be unavailable in private mode; width still works in-memory.
    }
  }, [width])

  const beginResize = useCallback(
    (event: MouseEvent<HTMLHRElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      setResizing(true)

      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        setWidth(clamp(startWidth + moveEvent.clientX - startX))
      }
      const handleUp = () => {
        setResizing(false)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [width]
  )

  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setWidth((current) => clamp(current - KEYBOARD_STEP))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth((current) => clamp(current + KEYBOARD_STEP))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWidth(WORKSPACE_SIDEBAR_MIN)
    } else if (event.key === 'End') {
      event.preventDefault()
      setWidth(WORKSPACE_SIDEBAR_MAX)
    }
  }, [])

  return { beginResize, onResizeKeyDown, resizing, width }
}
