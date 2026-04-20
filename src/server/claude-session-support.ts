import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { AgentLaunchConfigInput } from './agent-run-store.js'
import {
  captureSessionIdWithCoordinator,
  resetSessionCaptureCoordinatorForTests,
} from './claude-session-coordinator.js'

const CLAUDE_SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getClaudeProjectsRoot = () =>
  process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')

export const isClaudeCommand = (command: string) => basename(command) === 'claude'
export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[/:\s]/g, '-')

const listClaudeSessionIds = (cwd: string) => {
  const projectDir = join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd))
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CLAUDE_SESSION_FILE.test(entry.name))
      .map((entry) => entry.name.replace(/\.jsonl$/i, ''))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

export const getClaudeSessionFilePath = (cwd: string, sessionId: string) =>
  join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)

export const claudeSessionExists = (cwd: string, sessionId: string) =>
  CLAUDE_SESSION_FILE.test(`${sessionId}.jsonl`) &&
  existsSync(getClaudeSessionFilePath(cwd, sessionId))

export const withClaudeResumeArgs = (
  config: AgentLaunchConfigInput,
  lastSessionId: string | undefined,
  cwd?: string
) => {
  if (!lastSessionId || !config.resumeArgsTemplate) return config
  if (cwd && !claudeSessionExists(cwd, lastSessionId)) return config
  const args = config.args ?? []
  if (args.includes('--resume') || args.includes('--continue')) return config

  return {
    command: config.command,
    args: config.resumeArgsTemplate
      .replace('{session_id}', lastSessionId)
      .trim()
      .split(/\s+/)
      .concat(args),
    resumeArgsTemplate: config.resumeArgsTemplate,
    resumedSessionId: lastSessionId,
    sessionIdCapture: config.sessionIdCapture ?? null,
  } satisfies AgentLaunchConfigInput
}

export const getDefaultClaudeSessionCapture = () => ({
  pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
  source: 'claude_project_jsonl_dir' as const,
})

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listClaudeSessionIds(cwd),
    onCapture,
    projectKey: join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd)),
    timeoutMs,
  })
}

export const snapshotClaudeSessionIds = (cwd: string) => new Set(listClaudeSessionIds(cwd))

export const resetClaudeSessionClaimsForTests = () => {
  resetSessionCaptureCoordinatorForTests()
}
