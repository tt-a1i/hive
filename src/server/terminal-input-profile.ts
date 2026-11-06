import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getStartupCommandExecutable, normalizeExecutableToken } from './startup-command-parser.js'

export type TerminalInputProfile = 'claude' | 'codex' | 'default' | 'grok' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  has_user_input_since_start?: boolean | null
  run_id: string
  startup_blocked_reason?: 'first_run_setup' | null
  status: string
  terminal_input_profile: TerminalInputProfile
}

const PROFILE_BY_BRAND: Partial<Record<string, TerminalInputProfile>> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
}

// Shells whose spawn shape wraps the real command line in their final
// argument (`cmd /d /s /c <line>`, `zsh -lic <line>`). Legacy launch configs
// persisted before interactiveCommand existed only have this shape, so the
// profile must see through it or those rows degrade to 'default' forever.
const SHELL_WRAPPERS = new Set(['bash', 'cmd', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh'])
const NPX_WRAPPERS = new Set(['bunx', 'npx', 'pnpx'])

const isCodexNpmEntrypoint = (arg: string | undefined): boolean => {
  if (!arg) return false
  const normalized = arg.replace(/\\/gu, '/')
  return /(?:^|\/)@openai\/codex\/bin\/codex\.js$/iu.test(normalized)
}

const brandFromToken = (token: string | undefined): string | null => normalizeExecutableToken(token)

const stripNpmScope = (pkg: string): string =>
  pkg.startsWith('@') ? (pkg.split('/').at(-1) ?? pkg) : pkg

const tokenizeCommandLine = (line: string): string[] =>
  line.match(/"[^"]*"|'[^']*'|[^\s'"]+/gu)?.map((token) => token.replace(/^["']|["']$/gu, '')) ?? []

/**
 * Walk a token list and resolve the CLI brand of the command that will
 * actually own the terminal, seeing through shell wrappers (skipping their
 * flag tokens), npx-style runners, and `node <entrypoint>` launches.
 */
const profileFromTokens = (tokens: string[]): TerminalInputProfile | undefined => {
  let index = 0
  while (index < tokens.length) {
    const executable = brandFromToken(tokens[index])
    if (!executable) return undefined
    const direct = PROFILE_BY_BRAND[executable]
    if (direct) return direct
    if (SHELL_WRAPPERS.has(executable)) {
      index += 1
      while (index < tokens.length && /^[-/]/u.test(tokens[index] ?? '')) index += 1
      continue
    }
    if (NPX_WRAPPERS.has(executable)) {
      index += 1
      while (index < tokens.length && tokens[index]?.startsWith('-')) index += 1
      const pkg = tokens[index]
      if (!pkg) return undefined
      const brand = brandFromToken(stripNpmScope(pkg))
      return brand ? PROFILE_BY_BRAND[brand] : undefined
    }
    if (executable === 'node') {
      return tokens.slice(index + 1).some(isCodexNpmEntrypoint) ? 'codex' : undefined
    }
    return undefined
  }
  return undefined
}

const profileFromCommandText = (
  text: string | null | undefined
): TerminalInputProfile | undefined => {
  if (!text?.trim()) return undefined
  // Fast paths: the first (possibly quoted) token, and the whole text as one
  // token — the latter covers unquoted Windows paths with spaces such as
  // `C:\Program Files\nodejs\opencode.cmd`.
  for (const candidate of [getStartupCommandExecutable(text), text]) {
    const brand = brandFromToken(candidate ?? undefined)
    const profile = brand ? PROFILE_BY_BRAND[brand] : undefined
    if (profile) return profile
  }
  return profileFromTokens(tokenizeCommandLine(text))
}

const profileFromSpawnArgs = (config: AgentLaunchConfigInput): TerminalInputProfile | undefined => {
  const executable = brandFromToken(config.command)
  if (!executable || !config.args?.length) return undefined
  if (SHELL_WRAPPERS.has(executable)) {
    // The wrapped command line rides in the shell's final argument.
    return profileFromCommandText(config.args.at(-1))
  }
  if (NPX_WRAPPERS.has(executable)) {
    return profileFromTokens([executable, ...config.args])
  }
  if (executable === 'node') {
    return config.args.some(isCodexNpmEntrypoint) ? 'codex' : undefined
  }
  return undefined
}

export const resolveTerminalInputProfile = (
  config: AgentLaunchConfigInput | undefined
): TerminalInputProfile => {
  if (!config) return 'default'
  if (config.commandPresetId === 'claude') return 'claude'
  if (config.commandPresetId === 'codex') return 'codex'
  if (config.commandPresetId === 'grok') return 'grok'
  if (config.commandPresetId === 'opencode') return 'opencode'
  if (config.sessionIdCapture?.source === 'codex_session_jsonl_dir') return 'codex'
  if (config.sessionIdCapture?.source === 'claude_project_jsonl_dir') return 'claude'
  if (config.sessionIdCapture?.source === 'opencode_session_db') return 'opencode'

  return (
    profileFromCommandText(config.interactiveCommand) ??
    profileFromCommandText(config.command) ??
    profileFromSpawnArgs(config) ??
    'default'
  )
}
