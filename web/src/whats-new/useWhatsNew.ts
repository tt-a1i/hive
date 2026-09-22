import { useCallback, useEffect, useMemo, useState } from 'react'

import { APP_VERSION } from '../version.js'
import { type ChangelogEntry, selectWhatsNew, type WhatsNewSelection } from './changelog.js'

const KEY = 'hive.last-seen-version'
const LEGACY_EXISTING_USER_BASELINE = '1.7.0'
type LastSeenState = string | null | undefined

const readLastSeen = (current: string, hasExistingWorkspace: boolean): string | null => {
  try {
    const lastSeen = window.localStorage.getItem(KEY)
    if (lastSeen) return lastSeen
    // Users who already have a workspace but predate this localStorage key are
    // existing users, not fresh installs. Treat them as upgrading from the last
    // public build before the remote/mobile release series so the cumulative
    // What's New panel is not silently skipped.
    if (hasExistingWorkspace) return LEGACY_EXISTING_USER_BASELINE
    return null
  } catch {
    // Storage unavailable (private mode): treat as already seen — no popup.
    return current
  }
}

const writeLastSeen = (version: string) => {
  try {
    window.localStorage.setItem(KEY, version)
  } catch {}
}

/**
 * Drives the "What's New" dialog.
 *
 * Shows the changelog entries between the last version the user saw and the
 * running build, once per upgrade. A fresh install (or an upgrade with no
 * curated notes) is seeded silently and never shown — onboarding belongs to
 * the first-run wizard.
 *
 * While the first-run wizard is open the dialog only DEFERS (open=false); it
 * does NOT record the version, so the upgrade popup still appears once the
 * wizard is dismissed. The version is recorded only on a silent seed or when
 * the user actually closes the dialog.
 */
export const useWhatsNew = ({
  hasExistingWorkspace,
  wizardOpen,
}: {
  hasExistingWorkspace: boolean | null
  wizardOpen: boolean
}): {
  open: boolean
  entries: ChangelogEntry[]
  close: () => void
} => {
  // APP_VERSION is a build-time constant, so it is intentionally absent from the
  // hook dependency lists below (it never changes across renders).
  const current = APP_VERSION
  const [lastSeen, setLastSeen] = useState<LastSeenState>(undefined)
  useEffect(() => {
    if (lastSeen !== undefined || hasExistingWorkspace === null) return
    setLastSeen(readLastSeen(current, hasExistingWorkspace))
  }, [hasExistingWorkspace, lastSeen])
  const selection = useMemo<WhatsNewSelection>(
    () =>
      lastSeen === undefined
        ? { show: false, entries: [], seedOnly: false }
        : selectWhatsNew(current, lastSeen),
    [lastSeen]
  )
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Fresh install / no-notes-in-range: record the version without showing.
    // (Never fires for the show case, so it can't swallow an upgrade popup.)
    if (selection.seedOnly) writeLastSeen(current)
  }, [selection.seedOnly])

  const close = useCallback(() => {
    writeLastSeen(current)
    setDismissed(true)
  }, [])

  return {
    open: selection.show && !dismissed && !wizardOpen,
    entries: selection.entries,
    close,
  }
}
