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
  const missingLaunchConfigs = new Set<string>()
  const cacheKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`
  const load = () => {
    launchConfigs.clear()
    workspaceByAgentId.clear()
    for (const row of store.listLaunchConfigs()) {
      launchConfigs.set(cacheKey(row.workspaceId, row.agentId), row.config)
      workspaceByAgentId.set(row.agentId, row.workspaceId)
    }
  }

  load()

  return {
    get(workspaceId: string, agentId: string) {
      const key = cacheKey(workspaceId, agentId)
      const config = launchConfigs.get(key)
      if (config) return config
      if (missingLaunchConfigs.has(key)) {
        throw new Error(`Agent launch config not found: ${agentId}`)
      }
      load()
      const reloadedConfig = launchConfigs.get(key)
      if (reloadedConfig) return reloadedConfig
      missingLaunchConfigs.add(key)
      throw new Error(`Agent launch config not found: ${agentId}`)
    },
    peek(workspaceId: string, agentId: string) {
      const key = cacheKey(workspaceId, agentId)
      const config = launchConfigs.get(key)
      if (config) return config
      if (missingLaunchConfigs.has(key)) return undefined
      load()
      const reloadedConfig = launchConfigs.get(key)
      if (reloadedConfig) return reloadedConfig
      missingLaunchConfigs.add(key)
      return undefined
    },
    getWorkspaceId(agentId: string) {
      return workspaceByAgentId.get(agentId)
    },
    save(workspaceId: string, agentId: string, input: AgentLaunchConfigInput) {
      const normalized = {
        command: input.command,
        args: input.args ?? [],
        commandPresetId: input.commandPresetId ?? null,
        cwd: input.cwd ?? null,
        interactiveCommand: input.interactiveCommand ?? null,
        presetAugmentationDisabled: input.presetAugmentationDisabled ?? false,
        resumeArgsTemplate: input.resumeArgsTemplate ?? null,
        sessionIdCapture: input.sessionIdCapture ?? null,
      }
      store.saveLaunchConfig(workspaceId, agentId, normalized)
      const key = cacheKey(workspaceId, agentId)
      launchConfigs.set(key, normalized)
      missingLaunchConfigs.delete(key)
      workspaceByAgentId.set(agentId, workspaceId)
    },
    remove(workspaceId: string, agentId: string) {
      store.deleteLaunchConfig(workspaceId, agentId)
      const key = cacheKey(workspaceId, agentId)
      launchConfigs.delete(key)
      missingLaunchConfigs.add(key)
      workspaceByAgentId.delete(agentId)
    },
    invalidate(workspaceId: string, agentId: string) {
      const key = cacheKey(workspaceId, agentId)
      launchConfigs.delete(key)
      missingLaunchConfigs.delete(key)
      workspaceByAgentId.delete(agentId)
    },
    setWorkspaceId(agentId: string, workspaceId: string) {
      workspaceByAgentId.set(agentId, workspaceId)
    },
  }
}
