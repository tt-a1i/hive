import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SessionIdCaptureConfig } from './session-capture.js'
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

const getPresetYoloArgs = (preset: BoundPreset | null | undefined) => preset?.yoloArgsTemplate ?? []

const hasResumeArgs = (args: string[]) =>
  args.includes('--resume') ||
  args.includes('-r') ||
  args.includes('--continue') ||
  args.includes('-c') ||
  args.includes('--session') ||
  args.includes('-s') ||
  args[0] === 'resume'

const shouldVerifySessionBeforeResume = (capture: SessionIdCaptureConfig | null | undefined) => {
  // Claude is a cheap project-dir existence check; OpenCode is a direct DB query.
  // Codex/Gemini require broad session-store scans, so trust the persisted id and
  // let the CLI fail fast if it is stale.
  return capture?.source === 'claude_project_jsonl_dir' || capture?.source === 'opencode_session_db'
}

const supportsPresetResume = (capture: SessionIdCaptureConfig | null | undefined) =>
  capture?.source === 'claude_project_jsonl_dir' ||
  capture?.source === 'codex_session_jsonl_dir' ||
  capture?.source === 'gemini_session_json_dir' ||
  capture?.source === 'opencode_session_db'

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
  if (sessionIdCapture && !supportsPresetResume(sessionIdCapture)) return nextConfig
  if (
    cwd &&
    sessionIdCapture &&
    shouldVerifySessionBeforeResume(sessionIdCapture) &&
    !doesCapturedSessionExist(cwd, sessionIdCapture, lastSessionId)
  ) {
    return nextConfig
  }
  const args = config.args ?? []
  if (hasResumeArgs(args)) return nextConfig
  const yoloArgs = getPresetYoloArgs(preset)
  const resumeArgs = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim().split(/\s+/)

  return {
    ...nextConfig,
    args: appendUniqueArgs(yoloArgs, resumeArgs.concat(args)),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
