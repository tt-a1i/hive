import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { getCodexHome } from './session-capture-codex.js'

// Codex records per-directory trust in ~/.codex/config.toml as a table:
//
//   [projects."/abs/path"]
//   trust_level = "trusted"
//
// Without it, codex shows a blocking "Do you trust the contents of this
// directory?" prompt on first launch in that cwd. Like the claude case, this
// also stalls Hive's startup-message injection (the post-start writer's
// first-run setup guard matches "Do you trust" and waits out the hard timeout
// into a still-open dialog). Pre-seeding the table before we spawn codex makes
// the prompt never appear.
//
// --dangerously-bypass-approvals-and-sandbox does NOT cover this: it skips
// command approvals / sandboxing, not the pre-session directory trust gate.

const getCodexConfigPath = (codexDir: string) => join(codexDir, 'config.toml')

// JSON escaping also covers TOML basic-string controls, except DEL.
const toTomlQuotedKey = (value: string) => JSON.stringify(value).replace(/\x7f/g, '\\u007f')

// Match the exact section header for this cwd, e.g. [projects."/abs/path"],
// tolerating optional whitespace inside the brackets. Anchored per-line.
const hasProjectSection = (toml: string, cwd: string): boolean => {
  const header = `[projects.${toTomlQuotedKey(cwd)}]`
  return toml.split('\n').some((line) => line.trim() === header)
}

const readConfig = (configPath: string): string => {
  try {
    return readFileSync(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Ensure the effective Codex config.toml trusts `cwd` so codex does not show its first-run
 * directory-trust prompt there. Appends a `[projects."<cwd>"]` table with
 * `trust_level = "trusted"` only when that section is absent; existing content
 * (every other project table and all top-level settings) is preserved
 * verbatim. Writes atomically (temp + rename).
 *
 * Never throws — a failure degrades to codex showing its prompt (the
 * pre-existing behaviour), so it must not block member startup.
 *
 * @param cwd      Absolute workspace path codex will launch in.
 * @param homeDir  Legacy user HOME override; when provided, uses HOME/.codex.
 * @param codexHome  Exact Codex directory override, as passed to the launched CLI.
 */
export const ensureCodexDirectoryTrusted = (
  cwd: string,
  homeDir?: string,
  codexHome?: string
): void => {
  try {
    const codexDir =
      codexHome !== undefined
        ? resolve(cwd, codexHome)
        : homeDir !== undefined
          ? join(homeDir, '.codex')
          : getCodexHome(undefined, process.platform, cwd)
    const configPath = getCodexConfigPath(codexDir)
    const existing = readConfig(configPath)
    if (hasProjectSection(existing, cwd)) return

    const section = `[projects.${toTomlQuotedKey(cwd)}]\ntrust_level = "trusted"\n`
    // Separate from prior content with a blank line, matching codex's own
    // formatting. An empty/period-terminated file needs no leading newline.
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    const next = `${existing}${separator}${section}`

    mkdirSync(codexDir, { recursive: true })
    const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600
    const tempPath = `${configPath}.hive-${randomUUID()}.tmp`
    const fd = openSync(tempPath, 'wx', 0o600)
    try {
      try {
        fchmodSync(fd, mode)
        writeFileSync(fd, next, 'utf8')
      } finally {
        closeSync(fd)
      }
      renameSync(tempPath, configPath)
    } finally {
      rmSync(tempPath, { force: true })
    }
  } catch (error) {
    console.error('[hive] swallowed:codexTrustStore.ensureTrusted', error)
  }
}
