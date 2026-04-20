import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  captureSessionIdWithCoordinator,
  resetSessionCaptureCoordinatorForTests,
} from './claude-session-coordinator.js'

const SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getDefaultProjectsRoot = () =>
  process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')

export const getClaudeProjectsRoot = (pattern?: string) => {
  if (!pattern) return getDefaultProjectsRoot()
  const markerIndex = pattern.indexOf('{encoded_cwd}')
  if (markerIndex === -1) return getDefaultProjectsRoot()
  const root = pattern.slice(0, markerIndex).replace(/[\\/]+$/, '')
  if (!root) return getDefaultProjectsRoot()
  if (root === '~' || root.startsWith('~/')) {
    return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
  }
  return root
}

export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[/:\s]/g, '-')

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

export const getClaudeSessionFilePath = (cwd: string, sessionId: string, pattern?: string) =>
  join(getClaudeProjectsRoot(pattern), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)

export const hasClaudeSessionFile = (cwd: string, sessionId: string, pattern?: string) =>
  SESSION_FILE.test(`${sessionId}.jsonl`) &&
  existsSync(getClaudeSessionFilePath(cwd, sessionId, pattern))

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  projectsRoot = getDefaultProjectsRoot()
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, projectsRoot),
    onCapture,
    projectKey: join(projectsRoot, encodeClaudeProjectPath(cwd)),
    timeoutMs,
  })
}

export const snapshotClaudeSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) =>
  new Set(listSessionIds(cwd, projectsRoot))

export const resetClaudeSessionClaimsForTests = () => {
  resetSessionCaptureCoordinatorForTests()
}
