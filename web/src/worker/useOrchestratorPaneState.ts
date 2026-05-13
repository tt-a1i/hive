import { useCallback, useEffect, useState } from 'react'
import type { TerminalRunSummary } from '../api.js'
import { type OrchestratorStartResult, startAgentRun, stopAgentRun } from '../api.js'
import { findOrchestratorRun, orchestratorAgentId } from '../terminal/useTerminalRuns.js'
import type { OrchestratorPaneState } from './OrchestratorPane.js'

interface UseOrchestratorPaneStateInput {
  workspaceId: string
  terminalRuns: TerminalRunSummary[]
  /** Latest known autostart error for this workspace (sticky until cleared). */
  autostartError: string | null
  /**
   * A just-created workspace may already have a server-side autostart run.
   * Suppress client-side auto-start briefly until terminalRuns catches up.
   */
  suppressAutostartRunId?: string | null
  onClearAutostartError: () => void
  /** Optional callback fired after a manual start succeeds — lets parent
   *  invalidate caches / refresh runs immediately. */
  onAfterStart?: (result: OrchestratorStartResult) => void
}

interface UseOrchestratorPaneStateOutput {
  state: OrchestratorPaneState
  start: () => void
  stop: () => void
  restart: () => void
}

/**
 * Derives the 3-state Orchestrator pane shape from the live terminal runs +
 * the last-known autostart error. Live `running` always wins; `failed` only
 * surfaces when there is no live run AND a sticky error is present.
 */
export const useOrchestratorPaneState = ({
  workspaceId,
  terminalRuns,
  autostartError,
  suppressAutostartRunId,
  onClearAutostartError,
  onAfterStart,
}: UseOrchestratorPaneStateInput): UseOrchestratorPaneStateOutput => {
  const orchestratorRun = findOrchestratorRun(terminalRuns, workspaceId)
  const agentId = orchestratorAgentId(workspaceId)
  const [pendingStartWorkspaceId, setPendingStartWorkspaceId] = useState<string | null>(null)
  const [optimisticRun, setOptimisticRun] = useState<{
    workspaceId: string
    runId: string
  } | null>(null)
  const [suppressedRunId, setSuppressedRunId] = useState<string | null>(null)
  const optimisticRunId = optimisticRun?.workspaceId === workspaceId ? optimisticRun.runId : null
  const suppressingAutostart = Boolean(suppressedRunId && !orchestratorRun && !optimisticRunId)

  useEffect(() => {
    setSuppressedRunId(suppressAutostartRunId ?? null)
  }, [suppressAutostartRunId])

  useEffect(() => {
    if (orchestratorRun) {
      setPendingStartWorkspaceId(null)
      setOptimisticRun(null)
      setSuppressedRunId(null)
    }
  }, [orchestratorRun])

  useEffect(() => {
    if (!suppressedRunId || orchestratorRun) return
    const timer = window.setTimeout(() => setSuppressedRunId(null), 1500)
    return () => window.clearTimeout(timer)
  }, [suppressedRunId, orchestratorRun])

  useEffect(() => {
    if (!optimisticRunId || orchestratorRun) return
    const timer = window.setTimeout(() => setOptimisticRun(null), 2000)
    return () => window.clearTimeout(timer)
  }, [optimisticRunId, orchestratorRun])

  let state: OrchestratorPaneState
  if (orchestratorRun) {
    state = { kind: 'running', runId: orchestratorRun.run_id }
  } else if (optimisticRunId) {
    state = { kind: 'running', runId: optimisticRunId }
  } else if (autostartError) {
    state = { kind: 'failed', error: autostartError }
  } else {
    state = { kind: 'starting' }
  }

  const start = useCallback(() => {
    if (!workspaceId || pendingStartWorkspaceId === workspaceId || orchestratorRun) return
    onClearAutostartError()
    setPendingStartWorkspaceId(workspaceId)
    void startAgentRun(workspaceId, agentId)
      .then((result) => {
        setOptimisticRun({ workspaceId, runId: result.runId })
        onAfterStart?.({ ok: true, error: null, run_id: result.runId })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to start Queen'
        setOptimisticRun(null)
        onAfterStart?.({ ok: false, error: message, run_id: null })
      })
      .finally(() =>
        setPendingStartWorkspaceId((current) => (current === workspaceId ? null : current))
      )
  }, [
    agentId,
    onAfterStart,
    onClearAutostartError,
    orchestratorRun,
    pendingStartWorkspaceId,
    workspaceId,
  ])

  useEffect(() => {
    if (
      state.kind !== 'starting' ||
      suppressingAutostart ||
      pendingStartWorkspaceId === workspaceId
    ) {
      return
    }
    start()
  }, [pendingStartWorkspaceId, start, state.kind, suppressingAutostart, workspaceId])

  const stop = useCallback(() => {
    if (!orchestratorRun) return
    void stopAgentRun(orchestratorRun.run_id).catch((error: unknown) => {
      console.error('[hive] swallowed:orchestrator.stop', error)
    })
  }, [orchestratorRun])

  const restart = useCallback(() => {
    onClearAutostartError()
    if (orchestratorRun) {
      void stopAgentRun(orchestratorRun.run_id)
        .catch((error: unknown) => {
          // Best-effort stop before restart; failure is reported via the
          // subsequent .catch on startAgentRun if start fails.
          console.error('[hive] swallowed:orchestrator.restart.stop', error)
        })
        .then(() => startAgentRun(workspaceId, agentId))
        .then((result) => {
          setOptimisticRun({ workspaceId, runId: result.runId })
          onAfterStart?.({ ok: true, error: null, run_id: result.runId })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to restart Queen'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
      return
    }
    start()
  }, [agentId, onAfterStart, onClearAutostartError, orchestratorRun, start, workspaceId])

  return { state, start, stop, restart }
}
