import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { doesCapturedSessionExist } from './session-capture.js'

type BoundPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const appendUniqueArgs = (prefix: string[], args: string[]) => {
  const seen = new Set(prefix)
  return prefix.concat(args.filter((arg) => !seen.has(arg)))
}

const getEffectiveCapture = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.sessionIdCapture ?? preset?.sessionIdCapture ?? null

const getEffectiveResumeTemplate = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.resumeArgsTemplate ?? preset?.resumeArgsTemplate ?? null

const withPresetYoloArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => {
  const yoloArgs = preset?.yoloArgsTemplate
  if (!yoloArgs?.length) return config
  const nextArgs = appendUniqueArgs(yoloArgs, config.args ?? [])
  if (
    nextArgs.length === (config.args ?? []).length &&
    nextArgs.every((arg, index) => arg === (config.args ?? [])[index])
  ) {
    return config
  }
  return { ...config, args: nextArgs }
}

const hasResumeArgs = (args: string[]) =>
  args.includes('--resume') ||
  args.includes('-r') ||
  args.includes('--continue') ||
  args.includes('-c') ||
  args.includes('--session') ||
  args.includes('-s') ||
  args[0] === 'resume'

export const withPresetResumeArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined,
  lastSessionId: string | undefined,
  cwd?: string
) => {
  let nextConfig = withPresetYoloArgs(config, preset)
  const sessionIdCapture = getEffectiveCapture(nextConfig, preset)
  if (sessionIdCapture && sessionIdCapture !== nextConfig.sessionIdCapture) {
    nextConfig = { ...nextConfig, sessionIdCapture }
  }

  const resumeArgsTemplate = getEffectiveResumeTemplate(nextConfig, preset)
  if (!lastSessionId || !resumeArgsTemplate) return nextConfig
  if (cwd && sessionIdCapture && !doesCapturedSessionExist(cwd, sessionIdCapture, lastSessionId)) {
    return nextConfig
  }
  const args = nextConfig.args ?? []
  if (hasResumeArgs(args)) return nextConfig

  return {
    ...nextConfig,
    args: resumeArgsTemplate
      .replace('{session_id}', lastSessionId)
      .trim()
      .split(/\s+/)
      .concat(args),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
