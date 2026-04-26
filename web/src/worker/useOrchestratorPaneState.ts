import { useCallback } from 'react'
import type { TerminalRunSummary } from '../api.js'
import { type OrchestratorStartResult, startAgentRun, stopAgentRun } from '../api.js'
import { findOrchestratorRun, orchestratorAgentId } from '../terminal/useTerminalRuns.js'
import type { OrchestratorPaneState } from './OrchestratorPane.js'

interface UseOrchestratorPaneStateInput {
  workspaceId: string
  hivePort: string
  terminalRuns: TerminalRunSummary[]
  /** Latest known autostart error for this workspace (sticky until cleared). */
  autostartError: string | null
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
  hivePort,
  terminalRuns,
  autostartError,
  onClearAutostartError,
  onAfterStart,
}: UseOrchestratorPaneStateInput): UseOrchestratorPaneStateOutput => {
  const orchestratorRun = findOrchestratorRun(terminalRuns, workspaceId)
  const agentId = orchestratorAgentId(workspaceId)

  let state: OrchestratorPaneState
  if (orchestratorRun) {
    state = { kind: 'running', runId: orchestratorRun.run_id }
  } else if (autostartError) {
    state = { kind: 'failed', error: autostartError }
  } else {
    state = { kind: 'idle' }
  }

  const start = useCallback(() => {
    onClearAutostartError()
    void startAgentRun(workspaceId, agentId, hivePort)
      .then((result) => onAfterStart?.({ ok: true, error: null, run_id: result.runId }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to start Queen'
        onAfterStart?.({ ok: false, error: message, run_id: null })
      })
  }, [agentId, hivePort, onAfterStart, onClearAutostartError, workspaceId])

  const stop = useCallback(() => {
    if (!orchestratorRun) return
    void stopAgentRun(orchestratorRun.run_id).catch(() => {})
  }, [orchestratorRun])

  const restart = useCallback(() => {
    onClearAutostartError()
    if (orchestratorRun) {
      void stopAgentRun(orchestratorRun.run_id)
        .catch(() => {})
        .then(() => startAgentRun(workspaceId, agentId, hivePort))
        .then((result) => onAfterStart?.({ ok: true, error: null, run_id: result.runId }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to restart Queen'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
      return
    }
    start()
  }, [agentId, hivePort, onAfterStart, onClearAutostartError, orchestratorRun, start, workspaceId])

  return { state, start, stop, restart }
}
