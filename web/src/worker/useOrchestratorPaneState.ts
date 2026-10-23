import { useCallback, useEffect, useState } from 'react'
import type { TerminalRunSummary } from '../api.js'
import {
  type CommandPreset,
  type OrchestratorStartResult,
  startAgentRun,
  stopAgentRun,
  switchAgentCommandPreset,
} from '../api.js'
import { findOrchestratorRun, orchestratorAgentId } from '../terminal/useTerminalRuns.js'
import type { OrchestratorPaneState } from './OrchestratorPane.js'

interface UseOrchestratorPaneStateInput {
  workspaceId: string
  terminalRuns: TerminalRunSummary[]
  /** Latest known autostart error for this workspace (sticky until cleared). */
  autostartError: string | null
  onClearAutostartError: () => void
  /** Optional callback fired after a manual start succeeds — lets parent
   *  invalidate caches / refresh runs immediately. */
  onAfterStart?: (result: OrchestratorStartResult) => void
  onRunClosed?: (workspaceId: string, runId: string) => void
}

interface UseOrchestratorPaneStateOutput {
  state: OrchestratorPaneState
  start: () => void
  stop: () => void
  restart: () => void
  switchCli: (preset: CommandPreset) => Promise<void>
}

/**
 * Derives the Orchestrator pane shape from live terminal runs + explicit
 * start attempts. Live `running` always wins; runtime restarts intentionally
 * land in `stopped` instead of silently autostarting a new CLI process.
 */
export const useOrchestratorPaneState = ({
  workspaceId,
  terminalRuns,
  autostartError,
  onClearAutostartError,
  onAfterStart,
  onRunClosed,
}: UseOrchestratorPaneStateInput): UseOrchestratorPaneStateOutput => {
  const orchestratorRun = findOrchestratorRun(terminalRuns, workspaceId)
  const agentId = orchestratorAgentId(workspaceId)
  const [pendingStartWorkspaceId, setPendingStartWorkspaceId] = useState<string | null>(null)

  useEffect(() => {
    if (orchestratorRun) {
      setPendingStartWorkspaceId(null)
    }
  }, [orchestratorRun])

  let state: OrchestratorPaneState
  if (orchestratorRun) {
    state = {
      hasUserInputSinceStart: orchestratorRun.has_user_input_since_start === true,
      kind: 'running',
      runId: orchestratorRun.run_id,
      startupBlockedReason: orchestratorRun.startup_blocked_reason ?? null,
    }
  } else if (pendingStartWorkspaceId === workspaceId) {
    state = { kind: 'starting' }
  } else if (autostartError) {
    state = { kind: 'failed', error: autostartError }
  } else {
    state = { kind: 'stopped' }
  }

  const start = useCallback(() => {
    if (!workspaceId || pendingStartWorkspaceId === workspaceId || orchestratorRun) return
    onClearAutostartError()
    setPendingStartWorkspaceId(workspaceId)
    void startAgentRun(workspaceId, agentId)
      .then((result) => {
        onAfterStart?.({ ok: true, error: null, run_id: result.runId })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to start Queen'
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

  const stop = useCallback(() => {
    if (!orchestratorRun) return
    void stopAgentRun(orchestratorRun.run_id)
      .then(() => {
        onRunClosed?.(workspaceId, orchestratorRun.run_id)
      })
      .catch((error: unknown) => {
        console.error('[hive] swallowed:orchestrator.stop', error)
      })
  }, [onRunClosed, orchestratorRun, workspaceId])

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
          onRunClosed?.(workspaceId, orchestratorRun.run_id)
          onAfterStart?.({ ok: true, error: null, run_id: result.runId })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to restart Queen'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
      return
    }
    start()
  }, [
    agentId,
    onAfterStart,
    onClearAutostartError,
    onRunClosed,
    orchestratorRun,
    start,
    workspaceId,
  ])

  const switchCli = async (preset: CommandPreset) => {
    const result = await switchAgentCommandPreset(workspaceId, agentId, preset)
    onClearAutostartError()
    if (orchestratorRun) onRunClosed?.(workspaceId, orchestratorRun.run_id)
    onAfterStart?.({ ok: true, error: null, run_id: result.runId })
  }

  return { state, start, stop, restart, switchCli }
}
