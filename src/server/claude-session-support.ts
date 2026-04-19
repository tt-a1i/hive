import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { AgentLaunchConfigInput } from './agent-run-store.js'

const CLAUDE_SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getClaudeProjectsRoot = () => {
  return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')
}

const claimedSessionIdsByProjectDir = new Map<string, Set<string>>()
const capturePollersByProjectDir = new Map<string, ReturnType<typeof setInterval>>()
const captureWaitersByProjectDir = new Map<
  string,
  Array<{
    knownSessionIds: Set<string>
    onCapture: (sessionId: string) => void
    resolve: () => void
  }>
>()

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
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  } catch {
    return []
  }
}

export const getClaudeSessionFilePath = (cwd: string, sessionId: string) => {
  return join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)
}

export const claudeSessionExists = (cwd: string, sessionId: string) => {
  return (
    CLAUDE_SESSION_FILE.test(`${sessionId}.jsonl`) &&
    existsSync(getClaudeSessionFilePath(cwd, sessionId))
  )
}

export const withClaudeResumeArgs = (
  config: AgentLaunchConfigInput,
  lastSessionId: string | undefined,
  cwd?: string
) => {
  if (!lastSessionId || !config.resumeArgsTemplate) {
    return config
  }

  if (cwd && !claudeSessionExists(cwd, lastSessionId)) {
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
    resumedSessionId: lastSessionId,
    sessionIdCapture: config.sessionIdCapture ?? null,
  } satisfies AgentLaunchConfigInput
}

export const getDefaultClaudeSessionCapture = () => ({
  pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
  source: 'claude_project_jsonl_dir' as const,
})

const clearCapturePollerIfIdle = (projectDir: string) => {
  if ((captureWaitersByProjectDir.get(projectDir)?.length ?? 0) > 0) {
    return
  }

  const poller = capturePollersByProjectDir.get(projectDir)
  if (poller) {
    clearInterval(poller)
    capturePollersByProjectDir.delete(projectDir)
  }
  claimedSessionIdsByProjectDir.delete(projectDir)
}

const flushCaptureWaiters = (cwd: string, projectDir: string) => {
  const waiters = captureWaitersByProjectDir.get(projectDir)
  if (!waiters || waiters.length === 0) {
    clearCapturePollerIfIdle(projectDir)
    return
  }

  const claimedSessionIds = claimedSessionIdsByProjectDir.get(projectDir) ?? new Set<string>()
  claimedSessionIdsByProjectDir.set(projectDir, claimedSessionIds)
  const availableSessionIds = listClaudeSessionFiles(cwd)
    .map((entry) => entry.sessionId)
    .filter((sessionId) => !claimedSessionIds.has(sessionId))
  const remainingWaiters: typeof waiters = []

  for (const waiter of waiters) {
    const nextSessionId = availableSessionIds.find(
      (sessionId) => !waiter.knownSessionIds.has(sessionId)
    )
    if (!nextSessionId) {
      remainingWaiters.push(waiter)
      continue
    }

    claimedSessionIds.add(nextSessionId)
    availableSessionIds.splice(availableSessionIds.indexOf(nextSessionId), 1)
    waiter.onCapture(nextSessionId)
    waiter.resolve()
  }

  captureWaitersByProjectDir.set(projectDir, remainingWaiters)
  clearCapturePollerIfIdle(projectDir)
}

const ensureCapturePoller = (cwd: string, projectDir: string, intervalMs: number) => {
  if (capturePollersByProjectDir.has(projectDir)) {
    return
  }

  const poller = setInterval(() => {
    flushCaptureWaiters(cwd, projectDir)
  }, intervalMs)
  capturePollersByProjectDir.set(projectDir, poller)
}

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  const projectDir = join(getClaudeProjectsRoot(), encodeClaudeProjectPath(cwd))
  await new Promise<void>((resolve) => {
    let wrappedWaiter:
      | {
          knownSessionIds: Set<string>
          onCapture: (sessionId: string) => void
          resolve: () => void
        }
      | undefined
    const timeout = setTimeout(() => {
      const waiters = captureWaitersByProjectDir.get(projectDir) ?? []
      captureWaitersByProjectDir.set(
        projectDir,
        waiters.filter((candidate) => candidate !== wrappedWaiter)
      )
      clearCapturePollerIfIdle(projectDir)
      resolve()
    }, timeoutMs)
    wrappedWaiter = {
      knownSessionIds,
      onCapture,
      resolve: () => {
        clearTimeout(timeout)
        resolve()
      },
    }

    captureWaitersByProjectDir.set(projectDir, [
      ...(captureWaitersByProjectDir.get(projectDir) ?? []),
      wrappedWaiter,
    ])
    ensureCapturePoller(cwd, projectDir, intervalMs)
    flushCaptureWaiters(cwd, projectDir)
  })
}

export const snapshotClaudeSessionIds = (cwd: string) => {
  return new Set(listClaudeSessionFiles(cwd).map((entry) => entry.sessionId))
}

export const resetClaudeSessionClaimsForTests = () => {
  for (const poller of capturePollersByProjectDir.values()) {
    clearInterval(poller)
  }
  capturePollersByProjectDir.clear()
  captureWaitersByProjectDir.clear()
  claimedSessionIdsByProjectDir.clear()
}
