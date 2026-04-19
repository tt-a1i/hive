import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { AgentLaunchConfigInput } from './agent-run-store.js'

const CLAUDE_SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getClaudeProjectsRoot = () => {
  return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')
}

export const isClaudeCommand = (command: string) => basename(command) === 'claude'

export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[\\/:\s]/g, '-')

const listClaudeSessionFiles = (cwd: string) => {
  const projectDir = join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd))

  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CLAUDE_SESSION_FILE.test(entry.name))
      .map((entry) => ({
        sessionId: entry.name.replace(/\.jsonl$/i, ''),
      }))
  } catch {
    return []
  }
}

export const withClaudeResumeArgs = (
  config: AgentLaunchConfigInput,
  lastSessionId: string | undefined
) => {
  if (!lastSessionId || !config.resumeArgsTemplate) {
    return config
  }

  const args = config.args ?? []
  if (args.includes('--resume') || args.includes('--continue')) {
    return config
  }

  return {
    command: config.command,
    args: config.resumeArgsTemplate
      .replace('{session_id}', lastSessionId)
      .trim()
      .split(/\s+/)
      .concat(args),
    resumeArgsTemplate: config.resumeArgsTemplate,
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
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const session = listClaudeSessionFiles(cwd).find(
      (entry) => !knownSessionIds.has(entry.sessionId)
    )
    if (session) {
      onCapture(session.sessionId)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export const snapshotClaudeSessionIds = (cwd: string) => {
  return new Set(listClaudeSessionFiles(cwd).map((entry) => entry.sessionId))
}
