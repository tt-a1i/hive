import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getBuiltinCommandPresetByCommand } from './command-preset-defaults.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SessionCaptureSnapshot, SessionIdCaptureConfig } from './session-capture.js'
import { getCapturedSessionExistence } from './session-capture.js'
import { getStartupCommandExecutable, normalizeExecutableToken } from './startup-command-parser.js'

type BoundPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
> &
  Partial<Pick<CommandPresetRecord, 'command' | 'id'>>

const appendUniqueArgs = (prefix: string[], args: string[]) => {
  const seen = new Set(prefix)
  return prefix.concat(args.filter((arg) => !seen.has(arg)))
}

const unquoteExecutable = (command: string) => command.trim().replace(/^"(.+)"$/, '$1')

const isNodeExecutable = (command: string | null | undefined) => {
  if (!command) return false
  return /(?:^|[\\/])node(?:\.exe)?$/iu.test(unquoteExecutable(command))
}

const isCodexNpmEntrypoint = (arg: string | undefined) => {
  if (!arg) return false
  const normalized = arg.replace(/\\/gu, '/')
  return /(?:^|\/)@openai\/codex\/bin\/codex\.js$/iu.test(normalized)
}

const isCodexPreset = (preset: BoundPreset | null | undefined) =>
  preset?.id === 'codex' ||
  preset?.command === 'codex' ||
  preset?.sessionIdCapture?.source === 'codex_session_jsonl_dir'

const normalizeCodexNodeEntrypoint = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => {
  if (!isCodexPreset(preset) || !isNodeExecutable(config.command)) return config
  const args = config.args ?? []
  if (!isCodexNpmEntrypoint(args[0])) return config

  return {
    ...config,
    args: args.slice(1),
    command: preset?.command ?? 'codex',
    interactiveCommand: isNodeExecutable(config.interactiveCommand)
      ? 'codex'
      : (config.interactiveCommand ?? 'codex'),
  } satisfies AgentLaunchConfigInput
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

const splitShellCommand = (command: string) => {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

const getShellCommandArg = (args: readonly string[]) => {
  const commandFlagIndex = args.findIndex(
    (arg) => arg === '-c' || arg === '-ic' || arg === '-lc' || arg === '-lic'
  )
  if (commandFlagIndex >= 0) return args[commandFlagIndex + 1]
  const windowsCommandIndex = args.findIndex((arg) => arg.toLowerCase() === '/c')
  return windowsCommandIndex >= 0 ? args[windowsCommandIndex + 1] : undefined
}

type ResumeLaunchConfig = Pick<
  AgentLaunchConfigInput,
  | 'args'
  | 'command'
  | 'interactiveCommand'
  | 'resumedSessionId'
  | 'resumeArgsTemplate'
  | 'commandPresetId'
  | 'sessionIdCapture'
>

const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'ksh', 'fish', 'cmd'])
// Codex global options from its CLI help. Their values are never subcommands,
// even when a value itself is "resume" or looks like a resume flag.
const CODEX_VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '-m',
  '--model',
  '-s',
  '--sandbox',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '-a',
  '--ask-for-approval',
  '-i',
  '--image',
  '--add-dir',
  '--enable',
  '--disable',
  '--local-provider',
  '--remote',
  '--remote-auth-token-env',
])
const SHARED_VALUE_OPTIONS = new Set([
  '--model',
  '-m',
  '--prompt',
  '--system-prompt',
  '--append-system-prompt',
])

const hasResumeLaunchArgs = (
  args: readonly string[],
  command: string | null,
  resumeTemplate: string | null | undefined
) => {
  const templateTokens = splitShellCommand(resumeTemplate ?? '')
  const placeholder = templateTokens.findIndex((token) => token.includes('{session_id}'))
  const placeholderToken = templateTokens[placeholder]
  const inlineOption = placeholderToken?.endsWith('={session_id}')
    ? placeholderToken.slice(0, -'={session_id}'.length)
    : undefined
  const prefix =
    placeholder < 0
      ? templateTokens
      : inlineOption?.startsWith('-')
        ? []
        : templateTokens.slice(0, placeholder)
  // The option bound to the session placeholder is the resume marker. Other
  // template options (e.g. --model sonnet) also belong to fresh launches.
  const sessionOption = prefix.at(-1)
  const resumeOptions = new Set(sessionOption?.startsWith('-') ? [sessionOption] : [])
  if (inlineOption?.startsWith('-')) resumeOptions.add(inlineOption)
  if (command === 'claude' || command === 'hermes' || command === 'pi') {
    for (const flag of ['--resume', '-r', '--continue', '-c']) resumeOptions.add(flag)
  }
  if (command === 'pi') resumeOptions.add('--session')
  if (command === 'gemini' || command === 'qwen') resumeOptions.add('-r')
  if (command === 'qwen') {
    resumeOptions.add('--continue')
    resumeOptions.add('-c')
  }
  if (command === 'opencode') {
    for (const flag of ['--session', '-s', '--continue', '-c']) resumeOptions.add(flag)
  }
  const valueOptions = command === 'codex' ? CODEX_VALUE_OPTIONS : SHARED_VALUE_OPTIONS
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg || arg === '--') return false
    if (
      prefix.length > 0 &&
      !sessionOption?.startsWith('-') &&
      prefix.every((token, offset) => token !== '--' && args[index + offset] === token)
    )
      return true
    if (resumeOptions.has(arg.split('=')[0] ?? arg)) return true
    if (command === 'codex' && (arg === '--image' || arg === '-i')) {
      // Codex consumes one or more image paths up to the next option, including
      // paths literally named "resume". Attached values (--image=x, -ix)
      // end that option's consumption in the CLI's parser.
      while (args[index + 1] && !args[index + 1]?.startsWith('-')) index += 1
      continue
    }
    if (valueOptions.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    // Codex's resume is a subcommand; a prompt or another subcommand before
    // it cannot turn a later literal "resume" into a session restoration.
    if (command === 'codex') return arg === 'resume'
    if (prefix.length && !sessionOption?.startsWith('-')) {
      return prefix.every((token, offset) => args[index + offset] === token)
    }
  }
  return false
}

const hasResumeLaunchConfig = (config: ResumeLaunchConfig, preset?: BoundPreset | null) => {
  let command = normalizeExecutableToken(
    config.interactiveCommand ?? preset?.command ?? config.command
  )
  if (
    !getBuiltinCommandPresetByCommand(command ?? '') &&
    (config.commandPresetId === 'codex' ||
      config.sessionIdCapture?.source === 'codex_session_jsonl_dir')
  )
    command = 'codex'
  let args = config.args ?? []
  if (SHELL_COMMANDS.has(normalizeExecutableToken(config.command) ?? '')) {
    const shellCommand = getShellCommandArg(args)
    if (!shellCommand) return false
    const executable = normalizeExecutableToken(getStartupCommandExecutable(shellCommand))
    if (config.interactiveCommand && executable !== command) return false
    command = executable
    args = splitShellCommand(shellCommand).slice(1)
  }
  const template =
    getEffectiveResumeTemplate(config, preset) ??
    getBuiltinCommandPresetByCommand(command ?? '')?.resumeArgsTemplate
  return hasResumeLaunchArgs(args, command, template)
}

export const isResumeLaunchConfig = (config: ResumeLaunchConfig) =>
  Boolean(config.resumedSessionId) || hasResumeLaunchConfig(config)

const shouldVerifySessionBeforeResume = (
  capture: SessionIdCaptureConfig | null | undefined,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  // Claude is a cheap project-dir existence check; OpenCode is a direct DB query.
  // Bound Codex sessions also need ownership verification before automatic resume.
  return (
    capture?.source === 'claude_project_jsonl_dir' ||
    capture?.source === 'opencode_session_db' ||
    (capture?.source === 'codex_session_jsonl_dir' && Boolean(discriminator))
  )
}

const supportsPresetResume = (capture: SessionIdCaptureConfig | null | undefined) =>
  capture?.source === 'claude_project_jsonl_dir' ||
  capture?.source === 'codex_session_jsonl_dir' ||
  capture?.source === 'gemini_session_json_dir' ||
  capture?.source === 'opencode_session_db' ||
  capture?.source === 'qwen_session_json_dir' ||
  capture?.source === 'stdout_regex'

export const withPresetResumeArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined,
  lastSessionId: string | undefined,
  cwd?: string,
  discriminator?: SessionCaptureSnapshot['discriminator'],
  onInvalidSessionId?: (sessionId: string) => void
) => {
  // A shell launch owns its literal command text. CLI preset arguments cannot
  // be prepended to the shell's argv; explicit inner resume remains detectable
  // by isResumeLaunchConfig, while fresh/recovery guidance uses existing paths.
  if (SHELL_COMMANDS.has(normalizeExecutableToken(config.command) ?? '')) return config
  const launchConfig = normalizeCodexNodeEntrypoint(config, preset)
  let nextConfig = withPresetYoloArgs(launchConfig, preset)
  const sessionIdCapture = getEffectiveCapture(nextConfig, preset)
  if (sessionIdCapture && sessionIdCapture !== nextConfig.sessionIdCapture) {
    nextConfig = { ...nextConfig, sessionIdCapture }
  }

  const resumeArgsTemplate = getEffectiveResumeTemplate(nextConfig, preset)
  if (resumeArgsTemplate && resumeArgsTemplate !== nextConfig.resumeArgsTemplate) {
    nextConfig = { ...nextConfig, resumeArgsTemplate }
  }
  if (!lastSessionId || !resumeArgsTemplate) return nextConfig
  if (sessionIdCapture && !supportsPresetResume(sessionIdCapture)) return nextConfig
  if (
    sessionIdCapture?.source === 'codex_session_jsonl_dir' &&
    hasResumeLaunchConfig(launchConfig, preset)
  )
    return nextConfig
  if (cwd && sessionIdCapture && shouldVerifySessionBeforeResume(sessionIdCapture, discriminator)) {
    const existence = getCapturedSessionExistence(
      cwd,
      sessionIdCapture,
      lastSessionId,
      discriminator
    )
    if (existence !== true) {
      if (existence === false) onInvalidSessionId?.(lastSessionId)
      return nextConfig
    }
  }
  const args = launchConfig.args ?? []
  if (hasResumeLaunchConfig(launchConfig, preset)) return nextConfig
  const yoloArgs = getPresetYoloArgs(preset)
  const resumeArgs = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim().split(/\s+/)

  return {
    ...nextConfig,
    args: appendUniqueArgs(yoloArgs, resumeArgs.concat(args)),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
