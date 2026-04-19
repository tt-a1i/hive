import { randomUUID } from 'node:crypto'

export interface AgentTokenRegistry {
  /**
   * Mint a fresh token for this agent. A stale token from a prior run of the same agent
   * is overwritten; subsequent validate() calls with the stale token will return false.
   */
  issue: (agentId: string) => string
  peek: (agentId: string) => string | undefined
  /**
   * Revoke only if the currently registered token matches. Prevents a late onExit from
   * an old run from wiping the fresh token of a new run.
   */
  revokeIfMatches: (agentId: string, token: string) => void
  validate: (agentId: string, token: string | undefined) => boolean
}

export const createAgentTokenRegistry = (): AgentTokenRegistry => {
  const tokens = new Map<string, string>()
  return {
    issue(agentId) {
      const token = randomUUID()
      tokens.set(agentId, token)
      return token
    },
    peek(agentId) {
      return tokens.get(agentId)
    },
    revokeIfMatches(agentId, token) {
      if (tokens.get(agentId) === token) {
        tokens.delete(agentId)
      }
    },
    validate(agentId, token) {
      if (!token) return false
      const expected = tokens.get(agentId)
      return expected !== undefined && expected === token
    },
  }
}
