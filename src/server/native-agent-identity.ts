import { execFile } from 'node:child_process'
import type { AgentSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { isResumeLaunchConfig } from './preset-launch-support.js'

/** Only append when the real executable advertises support and the launch is uncustomized. */
export const nativeIdentityArgs = async (
  config: AgentLaunchConfigInput,
  preset: CommandPresetRecord | undefined,
  agent: AgentSummary | undefined,
  env: NodeJS.ProcessEnv,
  resumed: boolean
): Promise<string[]> => {
  if (
    process.platform === 'win32' ||
    !agent ||
    agent.spawnedBy === 'workflow' ||
    config.command !== 'claude' ||
    config.commandPresetId !== 'claude' ||
    !preset?.isBuiltin ||
    preset.command !== 'claude' ||
    config.presetAugmentationDisabled ||
    (config.args ?? []).length !== preset.args.length ||
    (config.args ?? []).some((arg, index) => arg !== preset.args[index]) ||
    (config.interactiveCommand && config.interactiveCommand !== 'claude') ||
    resumed ||
    isResumeLaunchConfig(config)
  )
    return []
  const supported = await new Promise<boolean>((resolve) => {
    execFile(
      config.command,
      ['--help'],
      { env, timeout: 1500, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve(!error && stdout.includes('--append-system-prompt'))
      }
    )
  })
  if (!supported) return []
  return [
    '--append-system-prompt',
    agent.role === 'orchestrator'
      ? 'You are the Hive Orchestrator. Coordinate Hive members through the team CLI. Use team guide core for current guidance.'
      : 'You are a Hive member. Work within your assigned role and use the team CLI for collaboration. Use team guide member for current guidance.',
  ]
}
