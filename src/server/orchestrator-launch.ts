import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { SettingsStore } from './settings-store.js'
import {
  createStartupCommandLaunch,
  getStartupCommandExecutable,
} from './startup-command-parser.js'
import { getOrchestratorId } from './workspace-store-support.js'

interface ConfigurePort {
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
}

const parseArgsEnv = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
  } catch {
    return trimmed.split(/\s+/)
  }
  return undefined
}

export const resolveCommandPresetLaunchConfig = (
  settings: SettingsStore,
  commandPresetId: string
): AgentLaunchConfigInput | undefined => {
  const preset = settings.getCommandPreset(commandPresetId)
  if (!preset) return undefined
  return {
    args: preset.args,
    command: preset.command,
    commandPresetId: preset.id,
  }
}

const findPresetForStartupCommand = (
  settings: SettingsStore,
  startupCommand: string,
  commandPresetId: string | null
) => {
  if (commandPresetId) return settings.getCommandPreset(commandPresetId)
  const executable = getStartupCommandExecutable(startupCommand)
  return executable ? settings.getCommandPreset(executable) : undefined
}

export const resolveStartupCommandLaunchConfig = (
  settings: SettingsStore,
  startupCommand: string,
  commandPresetId: string | null = null
): AgentLaunchConfigInput | undefined => {
  const trimmedStartupCommand = startupCommand.trim()
  if (!trimmedStartupCommand) return undefined
  const parsed = createStartupCommandLaunch(trimmedStartupCommand)
  const preset = findPresetForStartupCommand(settings, trimmedStartupCommand, commandPresetId)
  return {
    command: parsed.command,
    args: parsed.args,
    commandPresetId: null,
    interactiveCommand: preset?.command ?? getStartupCommandExecutable(trimmedStartupCommand),
    presetAugmentationDisabled: true,
    sessionIdCapture: preset?.sessionIdCapture ?? null,
  }
}

/**
 * Resolve the orchestrator's launch config in priority order:
 * 1. Explicit startup command pasted by the user. It runs through their shell
 *    so aliases/functions like `ccs --resume ...` can expand.
 * 2. Explicit workspace-create command preset chosen by the user.
 * 3. `HIVE_ORCHESTRATOR_COMMAND` env var (with optional `HIVE_ORCHESTRATOR_ARGS_JSON`).
 *    Tests use this to inject a dummy CLI like `bash -c 'echo queen up; sleep 60'`
 *    so autostart can run end-to-end without depending on a real `claude` binary.
 * 4. The seeded `orchestrator` role template (defaults to `claude`).
 * Returns `undefined` when neither source has a usable command.
 */
export const resolveOrchestratorLaunchConfig = (
  settings: SettingsStore,
  commandPresetId: string | null = null,
  startupCommand: string | null = null
): AgentLaunchConfigInput | undefined => {
  const trimmedStartupCommand = startupCommand?.trim()
  if (trimmedStartupCommand) {
    return resolveStartupCommandLaunchConfig(settings, trimmedStartupCommand, commandPresetId)
  }
  if (commandPresetId) {
    return resolveCommandPresetLaunchConfig(settings, commandPresetId)
  }
  const envCommand = process.env.HIVE_ORCHESTRATOR_COMMAND
  if (envCommand) {
    return {
      command: envCommand,
      args: parseArgsEnv(process.env.HIVE_ORCHESTRATOR_ARGS_JSON) ?? [],
      commandPresetId: null,
    }
  }
  const template = settings.listRoleTemplates().find((entry) => entry.roleType === 'orchestrator')
  if (!template) return undefined
  // Intentionally NOT binding to the `claude` command preset here: the preset
  // also wires session-id capture which can claim alice/bob workers' session
  // ids in tests / multi-agent setups. Users who want resume + yolo args can
  // re-configure via POST /api/workspaces/:wsId/agents/:agentId/config.
  return {
    command: template.defaultCommand,
    args: template.defaultArgs,
    commandPresetId: null,
  }
}

/**
 * Idempotent: only seeds when no existing launch config is present for the
 * orchestrator (prevents stomping on user-customized configs across restarts).
 */
export const seedOrchestratorLaunchConfig = (
  port: ConfigurePort,
  settings: SettingsStore,
  workspaceId: string,
  commandPresetId: string | null = null,
  startupCommand: string | null = null
): void => {
  const orchestratorId = getOrchestratorId(workspaceId)
  if (port.peekAgentLaunchConfig(workspaceId, orchestratorId)) return
  const config = resolveOrchestratorLaunchConfig(settings, commandPresetId, startupCommand)
  if (!config) return
  port.configureAgentLaunch(workspaceId, orchestratorId, config)
}
