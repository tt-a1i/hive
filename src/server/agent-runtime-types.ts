import type { AgentRunSnapshot } from './agent-manager.js'

export interface LiveAgentRun extends AgentRunSnapshot {
  /** Resolves after successful startup/recovery submission or readiness-only resume.
   * Rejects if startup fails or the run exits before readiness. Automated writes
   * await this barrier; raw terminal input remains available during setup. */
  postStartInputReady?: Promise<void>
  startedAt: number
  userStopped?: boolean
  captureController?: AbortController
  /** Epoch ms of successful live-run startup; null on pending or failed startup. */
  startupReadyAt?: number | null
}
