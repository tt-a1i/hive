import { basename } from 'node:path'
import { getBuiltinCommandPresetByCommand } from './command-preset-defaults.js'

const getEnvValue = (env: NodeJS.ProcessEnv, key: string, platform = process.platform) => {
  if (platform !== 'win32') return env[key]
  if (Object.hasOwn(env, key)) return env[key]
  const matchedKey = Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
  return matchedKey ? env[matchedKey] : undefined
}

const createPosixShellArgs = (shell: string, command: string) => {
  const shellName = basename(shell).toLowerCase()
  if (shellName.includes('bash') || shellName.includes('zsh') || shellName.includes('ksh')) {
    return ['-lic', command]
  }
  if (shellName.includes('fish')) return ['-ic', command]
  return ['-ic', command]
}

export const createStartupCommandLaunch = (
  startupCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
) => {
  const command = startupCommand
  if (platform === 'win32') {
    return {
      args: ['/d', '/s', '/c', command],
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }

  const shell = env.SHELL || '/bin/sh'
  return {
    args: createPosixShellArgs(shell, command),
    command: shell,
  }
}

export const getStartupCommandExecutable = (startupCommand: string) => {
  const command = startupCommand.trim()
  if (!command) return null
  // Match alternates, in order:
  //   1. Double-quoted token (may contain spaces, backslashes, slashes)
  //   2. Single-quoted token
  //   3. Bare token: no whitespace, no embedded quotes
  // An unbalanced opening quote falls through all three and returns null.
  // The previous regex used `[^'"\s]+` for the captured run, which forbade
  // spaces and therefore returned null for `"C:\Program Files\…claude.cmd"`
  // — the standard Windows install layout. See the parser tests for the
  // contract; brand identification belongs in agent-launch-resolver.
  const match = /^"([^"]+)"|^'([^']+)'|^([^\s'"]+)/.exec(command)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

/**
 * Reduce an executable token to its canonical brand id for preset lookup
 * and CLI-behavior dispatch. Splits on both '\\' and '/' so Windows paths
 * normalize even when the host runs `node:path.posix` (macOS test runners,
 * mixed-slash paths from npm-installed shims).
 *
 * Examples (return value in parens):
 *   'claude'                                  → 'claude'
 *   'claude.CMD'                              → 'claude'
 *   'C:\\Program Files\\nodejs\\claude.cmd'   → 'claude'
 *   '/usr/local/bin/codex'                    → 'codex'
 *   'C:/Users/me/opencode.CMD'                → 'opencode'
 *   'my-custom-runner.bat'                    → 'my-custom-runner'
 */
export const normalizeExecutableToken = (token: string | null | undefined): string | null => {
  if (!token) return null
  const lastSegment = token.replace(/^.*[\\/]/, '')
  if (!lastSegment) return null
  return lastSegment.toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/u, '')
}

const PACKAGE_RUNNER_WRAPPERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'node'])
const PACKAGE_RUNNER_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['dlx', 'exec']),
  yarn: new Set(['dlx', 'exec']),
}

const tokenizeCommandLine = (command: string, args: readonly string[] = []): string[] => {
  const trimmed = command.trim()
  // Match the same three alternatives as getStartupCommandExecutable, but
  // keep the RAW matched span (quotes included) so the remainder is sliced at
  // the true end of the executable token — slicing by the unquoted length
  // turned `"/path/npx" @openai/codex` into a garbage package token.
  const match = /^"([^"]+)"|^'([^']+)'|^([^\s'"]+)/.exec(trimmed)
  if (!match || match[0] === '') {
    // Unbalanced quote or empty: fall back to the whole trimmed command as a
    // single token (same fallback getStartupCommandExecutable callers had).
    return trimmed ? [trimmed, ...args] : [...args]
  }
  const executable = match[1] ?? match[2] ?? match[3]
  if (!executable) return [...args]
  const remainder = trimmed.slice(match[0].length).trim()
  const fromCommand = remainder.length === 0 ? [] : remainder.split(/\s+/u)
  return [executable, ...fromCommand, ...args]
}

const stripPackageSpec = (token: string): string | null => {
  let name = token.trim()
  if (!name) return null
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    name = slash === -1 ? name.slice(1) : name.slice(slash + 1)
  }
  const versionAt = name.lastIndexOf('@')
  if (versionAt > 0) name = name.slice(0, versionAt)
  return normalizeExecutableToken(name)
}

// Package aliases resolve through the existing built-in CLI identities.
// Unknown identities require an explicit CLI choice. CLI family does not
// establish model-provider diversity.
const CLI_PACKAGE_FAMILIES: ReadonlyMap<string, string> = new Map([
  ['claude-code', 'claude'], // @anthropic-ai/claude-code
  ['gemini-cli', 'gemini'], // @google/gemini-cli
  ['qwen-code', 'qwen'], // @qwen-code/qwen-code
  ['opencode-ai', 'opencode'], // opencode-ai
  ['pi-coding-agent', 'pi'], // @earendil-works/pi-coding-agent
])

export const canonicalCliFamily = (token: string | null): string | null => {
  if (token === null) return null
  return getBuiltinCommandPresetByCommand(CLI_PACKAGE_FAMILIES.get(token) ?? token)?.id ?? null
}

/**
 * Vendor identity for "same CLI family" checks. Package runners (`npx`,
 * `pnpm dlx`, `bunx`, `uvx`, `node`, …) are skipped so two `npx` presets
 * of different packages are different vendors. Returns null when no
 * usable token remains — callers must not treat null as a match.
 */
export const commandVendorToken = (
  command: string | null | undefined,
  args: readonly string[] = []
): string | null => {
  if (!command?.trim()) return null
  const tokens = tokenizeCommandLine(command, args)
  const first = normalizeExecutableToken(tokens[0])
  if (first === null) return null
  if (!PACKAGE_RUNNER_WRAPPERS.has(first)) return first
  let index = 1
  const subcommands = PACKAGE_RUNNER_SUBCOMMANDS[first]
  const maybeSub = tokens[index]
  if (subcommands && maybeSub && subcommands.has(maybeSub)) index += 1
  while (index < tokens.length && tokens[index]?.startsWith('-')) {
    const flag = tokens[index]
    if (flag === '--') {
      index += 1
      break
    }
    if (flag === '-y' || flag === '--yes' || flag === '--no-install' || flag === '--offline') {
      index += 1
      continue
    }
    if (first === 'uvx' && flag === '--from') return stripPackageSpec(tokens[index + 1] ?? '')
    if (first === 'uvx' && flag?.startsWith('--from=')) return stripPackageSpec(flag.slice(7))
    // An option's value may itself be a known CLI name (e.g. --cache codex).
    // Without an understood wrapper grammar, do not mistake it for the CLI.
    return null
  }
  const pkg = tokens[index]
  if (!pkg || pkg.startsWith('-')) return null
  return stripPackageSpec(pkg)
}
