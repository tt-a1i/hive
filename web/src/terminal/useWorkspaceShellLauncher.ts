import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { closeWorkspaceShell, startWorkspaceShell, type TerminalRunSummary } from '../api.js'
import type { TerminalTab } from './useTerminalPanelTabs.js'

type ShellPanelTabs = {
  openShellTab: (runId: string) => void
  setActive: (tabId: string) => void
  tabs: readonly TerminalTab[]
}

type UseWorkspaceShellLauncherArgs = {
  onCloseFailed: (message: string) => void
  onShellRunClosed?: ((workspaceId: string, runId: string) => void) | undefined
  onShellRunStarted?: ((workspaceId: string, run: TerminalRunSummary) => void) | undefined
  panelTabs: ShellPanelTabs
  shellRuns: TerminalRunSummary[]
  workspaceId: string | null
}

export const useWorkspaceShellLauncher = ({
  onCloseFailed,
  onShellRunClosed,
  onShellRunStarted,
  panelTabs,
  shellRuns,
  workspaceId,
}: UseWorkspaceShellLauncherArgs) => {
  const [shellError, setShellError] = useState<string | null>(null)
  const [shellRunId, setShellRunId] = useState<string | null>(null)
  const [shellStarting, setShellStarting] = useState(false)
  const shellStartInFlightByWorkspaceRef = useRef(new Map<string, number>())
  const shellStartRequestSeqRef = useRef(0)
  const closingShellRunIdsByWorkspaceRef = useRef(new Map<string, Set<string>>())
  const closingShellPromisesByWorkspaceRef = useRef(new Map<string, Map<string, Promise<void>>>())
  const shellStartAfterCloseByWorkspaceRef = useRef(new Set<string>())
  const selectedWorkspaceIdRef = useRef<string | null>(workspaceId)

  const activeShellRun = shellRuns.find((run) => run.run_id === shellRunId) ?? shellRuns[0] ?? null
  const activeShellRunId = activeShellRun?.run_id ?? null

  const markClosingShellRun = useCallback((targetWorkspaceId: string, runId: string) => {
    const ids = closingShellRunIdsByWorkspaceRef.current.get(targetWorkspaceId) ?? new Set<string>()
    ids.add(runId)
    closingShellRunIdsByWorkspaceRef.current.set(targetWorkspaceId, ids)
  }, [])

  const trackClosingShellPromise = useCallback(
    (targetWorkspaceId: string, runId: string, promise: Promise<void>) => {
      const workspacePromises =
        closingShellPromisesByWorkspaceRef.current.get(targetWorkspaceId) ??
        new Map<string, Promise<void>>()
      workspacePromises.set(runId, promise)
      closingShellPromisesByWorkspaceRef.current.set(targetWorkspaceId, workspacePromises)
      void promise
        .finally(() => {
          const current = closingShellPromisesByWorkspaceRef.current.get(targetWorkspaceId)
          if (!current) return
          current.delete(runId)
          if (current.size === 0)
            closingShellPromisesByWorkspaceRef.current.delete(targetWorkspaceId)
        })
        .catch(() => {})
    },
    []
  )

  const unmarkClosingShellRun = useCallback((targetWorkspaceId: string, runId: string) => {
    const ids = closingShellRunIdsByWorkspaceRef.current.get(targetWorkspaceId)
    if (!ids) return
    ids.delete(runId)
    if (ids.size === 0) closingShellRunIdsByWorkspaceRef.current.delete(targetWorkspaceId)
  }, [])

  useLayoutEffect(() => {
    selectedWorkspaceIdRef.current = workspaceId
  }, [workspaceId])

  useEffect(
    () => () => {
      closingShellRunIdsByWorkspaceRef.current.clear()
      closingShellPromisesByWorkspaceRef.current.clear()
      shellStartAfterCloseByWorkspaceRef.current.clear()
    },
    []
  )

  // Clear local launch state whenever the selected workspace changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires on workspace switch
  useEffect(() => {
    setShellError(null)
    setShellRunId(null)
    setShellStarting(false)
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    const closingIds = closingShellRunIdsByWorkspaceRef.current.get(workspaceId)
    if (!closingIds) return
    const liveShellRunIds = new Set(shellRuns.map((run) => run.run_id))
    const pendingClosePromises = closingShellPromisesByWorkspaceRef.current.get(workspaceId)
    for (const runId of Array.from(closingIds)) {
      if (pendingClosePromises?.has(runId)) continue
      if (!liveShellRunIds.has(runId)) unmarkClosingShellRun(workspaceId, runId)
    }
  }, [shellRuns, unmarkClosingShellRun, workspaceId])

  const startShell = () => {
    if (!workspaceId || shellStartInFlightByWorkspaceRef.current.has(workspaceId)) return
    const requestWorkspaceId = workspaceId
    const requestSeq = shellStartRequestSeqRef.current + 1
    shellStartRequestSeqRef.current = requestSeq
    shellStartInFlightByWorkspaceRef.current.set(requestWorkspaceId, requestSeq)
    const isSelectedWorkspace = () => selectedWorkspaceIdRef.current === requestWorkspaceId
    const ownsInFlightMarker = () =>
      shellStartInFlightByWorkspaceRef.current.get(requestWorkspaceId) === requestSeq
    setShellError(null)
    setShellStarting(true)
    void startWorkspaceShell(requestWorkspaceId)
      .then((run) => {
        onShellRunStarted?.(requestWorkspaceId, run)
        if (!isSelectedWorkspace()) return
        setShellRunId(run.run_id)
        panelTabs.openShellTab(run.run_id)
      })
      .catch((error) => {
        if (!isSelectedWorkspace()) return
        setShellError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (ownsInFlightMarker())
          shellStartInFlightByWorkspaceRef.current.delete(requestWorkspaceId)
        if (isSelectedWorkspace()) setShellStarting(false)
      })
  }

  const startShellAfterClosingRuns = () => {
    if (
      !workspaceId ||
      shellStartInFlightByWorkspaceRef.current.has(workspaceId) ||
      shellStartAfterCloseByWorkspaceRef.current.has(workspaceId)
    ) {
      return
    }

    const requestWorkspaceId = workspaceId
    const closingPromises = Array.from(
      closingShellPromisesByWorkspaceRef.current.get(requestWorkspaceId)?.values() ?? []
    )
    if (closingPromises.length === 0) {
      startShell()
      return
    }

    shellStartAfterCloseByWorkspaceRef.current.add(requestWorkspaceId)
    setShellError(null)
    setShellStarting(true)
    void Promise.allSettled(closingPromises)
      .then((results) => {
        if (results.some((result) => result.status === 'rejected')) return
        if (selectedWorkspaceIdRef.current !== requestWorkspaceId) return
        if (shellStartInFlightByWorkspaceRef.current.has(requestWorkspaceId)) return
        startShell()
      })
      .finally(() => {
        shellStartAfterCloseByWorkspaceRef.current.delete(requestWorkspaceId)
        if (
          selectedWorkspaceIdRef.current === requestWorkspaceId &&
          !shellStartInFlightByWorkspaceRef.current.has(requestWorkspaceId)
        ) {
          setShellStarting(false)
        }
      })
  }

  const startNewShell = () => {
    if (!workspaceId || shellStartInFlightByWorkspaceRef.current.has(workspaceId) || shellStarting)
      return
    const closingShellRunIds =
      closingShellRunIdsByWorkspaceRef.current.get(workspaceId) ?? new Set<string>()
    if (closingShellRunIds.size > 0) {
      startShellAfterClosingRuns()
      return
    }
    startShell()
  }

  const openShell = () => {
    if (!workspaceId || shellStartInFlightByWorkspaceRef.current.has(workspaceId) || shellStarting)
      return
    const existingShellTab = panelTabs.tabs.find((tab) => tab.kind === 'shell')
    if (existingShellTab) {
      panelTabs.setActive(existingShellTab.id)
      return
    }
    const closingShellRunIds =
      closingShellRunIdsByWorkspaceRef.current.get(workspaceId) ?? new Set<string>()
    const reusableShellRun = shellRuns.find((run) => !closingShellRunIds.has(run.run_id))
    if (reusableShellRun) {
      setShellRunId(reusableShellRun.run_id)
      panelTabs.openShellTab(reusableShellRun.run_id)
      return
    }
    if (closingShellRunIds.size > 0) {
      startShellAfterClosingRuns()
      return
    }
    startShell()
  }

  const closeShellTab = (runId: string) => {
    if (!workspaceId) return
    const fallbackRun = shellRuns.find((run) => run.run_id !== runId) ?? null
    if (activeShellRunId === runId) setShellRunId(fallbackRun?.run_id ?? null)
    onShellRunClosed?.(workspaceId, runId)
    markClosingShellRun(workspaceId, runId)
    const closePromise = closeWorkspaceShell(workspaceId, runId).catch((error) => {
      unmarkClosingShellRun(workspaceId, runId)
      onCloseFailed(error instanceof Error ? error.message : String(error))
      throw error
    })
    trackClosingShellPromise(workspaceId, runId, closePromise)
    void closePromise.catch(() => {})
  }

  return {
    closeShellTab,
    openShell,
    shellError,
    shellStarting,
    startNewShell,
  }
}
