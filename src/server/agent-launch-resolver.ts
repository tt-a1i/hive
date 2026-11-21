import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { SettingsStore } from './settings-store.js'
import {
  createStartupCommandLaunch,
  getStartupCommandExecutable,
  normalizeExecutableToken,
} from './startup-command-parser.js'

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
  // Reduce the raw token (which may be a bare command, an absolute path,
  // or a Windows path with spaces and a .cmd suffix) to the canonical
  // brand id before looking up the preset. Without this normalization
  // step `getCommandPreset` only matched bare command names — Windows
  // users typing the full nvm4w path lost CLI brand identification,
  // session capture, and post-start input strategy in one swoop.
  const brandId = normalizeExecutableToken(getStartupCommandExecutable(startupCommand))
  return brandId ? settings.getCommandPreset(brandId) : undefined
}

export const resolveStartupCommandLaunchConfig = (
  settings: SettingsStore,
  startupCommand: string,
  commandPresetId: string | null = null
): AgentLaunchConfigInput | undefined => {
  const trimmedStartupCommand = startupCommand.trim()
  if (!trimmedStartupCommand) return undefined
  const parsed = createStartupCommandLaunch(startupCommand)
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
