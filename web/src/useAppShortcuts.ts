import { useMemo } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { useGlobalShortcuts } from './useGlobalShortcuts.js'

type UseAppShortcutsOptions = {
  activeWorkspace: WorkspaceSummary | null
  bootstrapError: string | null
  onSelectWorkspace: (workspaceId: string) => void
  onToggleTaskGraph: () => void
  onTriggerAddDialog: () => void
  workspaces: WorkspaceSummary[] | null
}

export const useAppShortcuts = ({
  activeWorkspace,
  bootstrapError,
  onSelectWorkspace,
  onToggleTaskGraph,
  onTriggerAddDialog,
  workspaces,
}: UseAppShortcutsOptions) => {
  const shortcuts = useMemo(() => {
    const indexShortcuts = (workspaces ?? []).slice(0, 9).map((ws, idx) => ({
      key: String(idx + 1),
      mod: true,
      handler: () => onSelectWorkspace(ws.id),
    }))

    return [
      {
        key: 'b',
        mod: true,
        handler: () => {
          if (activeWorkspace) onToggleTaskGraph()
        },
      },
      {
        key: 'n',
        mod: true,
        shift: true,
        handler: () => {
          if (!bootstrapError) onTriggerAddDialog()
        },
      },
      ...indexShortcuts,
    ]
  }, [
    activeWorkspace,
    bootstrapError,
    onSelectWorkspace,
    onToggleTaskGraph,
    onTriggerAddDialog,
    workspaces,
  ])

  useGlobalShortcuts(shortcuts)
}
