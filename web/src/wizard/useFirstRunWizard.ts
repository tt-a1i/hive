import { useCallback, useEffect, useState } from 'react'

import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { useFirstRunFlag } from './useFirstRunFlag.js'

/**
 * Manages the FirstRunWizard's open state.
 *
 * Auto-opens the wizard once the workspace list has loaded and is empty,
 * provided the user has not seen it before. `closeWizard` marks the flag
 * so it won't auto-open again.
 *
 * Pass `null` for workspaces while the bootstrap is in flight; the wizard
 * will only open once the list is known (i.e., not null) and empty.
 */
export const useFirstRunWizard = (
  workspaces: WorkspaceSummary[] | null
): {
  wizardOpen: boolean
  closeWizard: (shouldMarkSeen?: boolean) => void
} => {
  const { seen, markSeen } = useFirstRunFlag()
  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    if (!seen && workspaces !== null && workspaces.length === 0) {
      setWizardOpen(true)
    }
  }, [seen, workspaces])

  const closeWizard = useCallback(
    (shouldMarkSeen = true) => {
      if (shouldMarkSeen) markSeen()
      setWizardOpen(false)
    },
    [markSeen]
  )

  return { wizardOpen, closeWizard }
}
