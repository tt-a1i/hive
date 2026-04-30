import { useRef, useState } from 'react'

import { saveActiveWorkspaceId } from './api.js'
import { logSwallowed } from './lib/log-swallowed.js'

export const useWorkspaceSelection = () => {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const activeWorkspaceSaveQueue = useRef(Promise.resolve())

  const selectWorkspace = (workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId)
    activeWorkspaceSaveQueue.current = activeWorkspaceSaveQueue.current
      .catch(logSwallowed('selectWorkspace.prevQueue'))
      .then(() => saveActiveWorkspaceId(workspaceId))
      .catch(logSwallowed('selectWorkspace.save'))
  }

  return { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId }
}
