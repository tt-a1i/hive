import { useEffect, useRef } from 'react'

/**
 * Auto-trigger the AddWorkspaceDialog the first time the workspaces list
 * loads as empty. The user shouldn't be stuck on a blank canvas.
 */
export const useEmptyStateAutoOpen = (
  workspaces: { length: number } | null,
  triggerAdd: () => void
): void => {
  const fired = useRef(false)
  useEffect(() => {
    if (workspaces === null) return
    if (workspaces.length === 0 && !fired.current) {
      fired.current = true
      triggerAdd()
    }
  }, [workspaces, triggerAdd])
}
