import type { RuntimeStore } from '../../src/server/runtime-store.js'

export const requireAgentToken = (store: RuntimeStore, agentId: string): string => {
  const token = store.peekAgentToken(agentId)
  if (!token) {
    throw new Error(`No token issued for agent: ${agentId}`)
  }
  return token
}
