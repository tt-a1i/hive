import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  captureSessionIdWithCoordinator,
  resetSessionCaptureCoordinatorForTests,
} from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath } from './platform-path.js'

const SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getDefaultProjectsRoot = () =>
  process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')

export const getClaudeProjectsRoot = (
  pattern?: string,
  platform: NodeJS.Platform = process.platform
) => {
  if (!pattern) return getDefaultProjectsRoot()
  const markerIndex = pattern.indexOf('{encoded_cwd}')
  if (markerIndex === -1) return getDefaultProjectsRoot()
  const root = pattern.slice(0, markerIndex).replace(/[\\/]+$/, '')
  if (!root) return getDefaultProjectsRoot()
  const builtInProjectsRoot = join(homedir(), '.claude', 'projects')
  const expandedRoot = expandHomePath(root)
  if (root === '~' || arePathsEqual(expandedRoot, builtInProjectsRoot, platform)) {
    return getDefaultProjectsRoot()
  }
  return expandedRoot
}

/**
 * Match the directory-name encoding Claude Code itself uses for its project
 * metadata under `~/.claude/projects/`. Empirically (probed via `claude
 * --print "x"` in directories named with each character) Claude Code
 * replaces *every* character outside `[A-Za-z0-9-]` with a single `-`,
 * one-for-one, preserving literal hyphens.
 *
 * The previous regex `[\\/:\s]` only matched `\`, `/`, `:`, and whitespace —
 * leaving `_`, `.`, parens, brackets, `@`, `#`, `&`, `+`, and any non-ASCII
 * character (including CJK usernames) intact, while Claude Code's own
 * encoder replaced them. The mismatch meant Hive looked for sessions under
 * a different directory than the one Claude Code wrote to, so session
 * resume silently failed for any workspace path containing those chars.
 * Windows + CJK Windows usernames (`C:\Users\张三\project`) and
 * underscored Windows project paths (`C:\my_project`) are the most common
 * triggers, but the bug is cross-platform.
 *
 * Backward compatibility: workspaces whose path contains ONLY chars that
 * the old regex already matched (`/\:` + whitespace) get the same encoded
 * dirname as before — no behavior change. Workspaces with any other
 * special chars previously had broken session resume; the fix moves them
 * to the correct (working) directory.
 */
export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[^A-Za-z0-9-]/g, '-')

const listSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) => {
  const projectDir = join(projectsRoot, encodeClaudeProjectPath(cwd))
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name))
      .map((entry) => entry.name.replace(/\.jsonl$/i, ''))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

interface ClaudeSessionCaptureDiscriminator {
  contentIncludes?: string | readonly string[]
}

const includesAny = (content: string, needles: string | readonly string[]) => {
  const normalizedNeedles = Array.isArray(needles) ? needles : [needles]
  return normalizedNeedles.some((needle) => content.includes(needle))
}

const sessionFileContainsAny = (
  cwd: string,
  projectsRoot: string,
  sessionId: string,
  contentIncludes: string | readonly string[]
) => {
  try {
    const content = readFileSync(
      join(projectsRoot, encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`),
      'utf8'
    )
    return includesAny(content, contentIncludes)
  } catch {
    return false
  }
}

export const getClaudeSessionFilePath = (cwd: string, sessionId: string, pattern?: string) =>
  join(getClaudeProjectsRoot(pattern), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)

export const hasClaudeSessionFile = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) => {
  if (
    !SESSION_FILE.test(`${sessionId}.jsonl`) ||
    !existsSync(getClaudeSessionFilePath(cwd, sessionId, pattern))
  ) {
    return false
  }
  const projectsRoot = getClaudeProjectsRoot(pattern)
  return discriminator.contentIncludes
    ? sessionFileContainsAny(cwd, projectsRoot, sessionId, discriminator.contentIncludes)
    : true
}

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {},
  signal?: AbortSignal
) => {
  const contentIncludes = discriminator.contentIncludes
  await captureSessionIdWithCoordinator({
    signal,
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, projectsRoot),
    onCapture,
    projectKey: join(projectsRoot, encodeClaudeProjectPath(cwd)),
    timeoutMs,
    ...(contentIncludes
      ? {
          matchesSessionId: (sessionId: string) =>
            sessionFileContainsAny(cwd, projectsRoot, sessionId, contentIncludes),
        }
      : {}),
  })
}

export const snapshotClaudeSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) =>
  new Set(listSessionIds(cwd, projectsRoot))

export const resetClaudeSessionClaimsForTests = () => {
  resetSessionCaptureCoordinatorForTests()
}
