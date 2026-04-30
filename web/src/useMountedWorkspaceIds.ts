import { useEffect, useState } from 'react'

export const useMountedWorkspaceIds = (activeWorkspaceId: string | null) => {
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    )
  }, [activeWorkspaceId])

  return [mountedWorkspaceIds, setMountedWorkspaceIds] as const
}
