import { useMemo } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { isStandalonePwa } from './pwa/is-standalone.js'
import { type Shortcut, useGlobalShortcuts } from './useGlobalShortcuts.js'

type UseAppShortcutsOptions = {
  bootstrapError: string | null
  onSelectWorkspace: (workspaceId: string) => void
  onTriggerAddDialog: () => void
  workspaces: WorkspaceSummary[] | null
}

export const useAppShortcuts = ({
  bootstrapError,
  onSelectWorkspace,
  onTriggerAddDialog,
  workspaces,
}: UseAppShortcutsOptions) => {
  const shortcuts = useMemo<Shortcut[]>(() => {
    // These bindings collide with OS-reserved browser shortcuts in a
    // regular tab — Ctrl+Shift+N opens an incognito window, Ctrl+1..9
    // switches the browser's own tabs — and the page cannot reliably
    // preventDefault them there. Inside an installed PWA window the
    // browser drops those bindings, so the shortcuts work as intended.
    // Skip registration outside of standalone mode rather than ship a
    // half-working override that varies by platform and browser.
    if (!isStandalonePwa()) return []

    const indexShortcuts = (workspaces ?? []).slice(0, 9).map<Shortcut>((ws, idx) => ({
      key: String(idx + 1),
      mod: true,
      handler: () => {
        onSelectWorkspace(ws.id)
        return undefined
      },
    }))

    return [
      {
        key: 'n',
        mod: true,
        shift: true,
        handler: () => {
          if (!bootstrapError) onTriggerAddDialog()
          return undefined
        },
      },
      ...indexShortcuts,
    ]
  }, [bootstrapError, onSelectWorkspace, onTriggerAddDialog, workspaces])

  useGlobalShortcuts(shortcuts)
}
