import type { AgentLaunchConfigInput } from './agent-run-store.js'

export interface AgentLaunchConfigRow {
  agentId: string
  config: AgentLaunchConfigInput
  workspaceId: string
}

interface AgentLaunchCacheStore {
  deleteLaunchConfig: (workspaceId: string, agentId: string) => void
  listLaunchConfigs: () => AgentLaunchConfigRow[]
  saveLaunchConfig: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => void
}

export const createAgentLaunchCache = (store: AgentLaunchCacheStore) => {
  const launchConfigs = new Map<string, AgentLaunchConfigInput>()
  const workspaceByAgentId = new Map<string, string>()
  const cacheKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`
  const load = () => {
    for (const row of store.listLaunchConfigs()) {
      launchConfigs.set(cacheKey(row.workspaceId, row.agentId), row.config)
      workspaceByAgentId.set(row.agentId, row.workspaceId)
    }
  }

  load()

  return {
    get(workspaceId: string, agentId: string) {
      const config = launchConfigs.get(cacheKey(workspaceId, agentId))
      if (config) return config
      load()
      const reloadedConfig = launchConfigs.get(cacheKey(workspaceId, agentId))
      if (reloadedConfig) return reloadedConfig
      throw new Error(`Agent launch config not found: ${agentId}`)
    },
    peek(workspaceId: string, agentId: string) {
      const config = launchConfigs.get(cacheKey(workspaceId, agentId))
      if (config) return config
      load()
      return launchConfigs.get(cacheKey(workspaceId, agentId))
    },
    getWorkspaceId(agentId: string) {
      return workspaceByAgentId.get(agentId)
    },
    save(workspaceId: string, agentId: string, input: AgentLaunchConfigInput) {
      const normalized = {
        command: input.command,
        args: input.args ?? [],
        commandPresetId: input.commandPresetId ?? null,
        resumeArgsTemplate: input.resumeArgsTemplate ?? null,
        sessionIdCapture: input.sessionIdCapture ?? null,
      }
      launchConfigs.set(cacheKey(workspaceId, agentId), normalized)
      workspaceByAgentId.set(agentId, workspaceId)
      store.saveLaunchConfig(workspaceId, agentId, normalized)
    },
    remove(workspaceId: string, agentId: string) {
      launchConfigs.delete(cacheKey(workspaceId, agentId))
      workspaceByAgentId.delete(agentId)
      store.deleteLaunchConfig(workspaceId, agentId)
    },
    setWorkspaceId(agentId: string, workspaceId: string) {
      workspaceByAgentId.set(agentId, workspaceId)
    },
  }
}
