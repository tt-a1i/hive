import type { AgentRunSnapshot } from './agent-manager.js'

export interface LiveAgentRun extends AgentRunSnapshot {
  startedAt: number
}
