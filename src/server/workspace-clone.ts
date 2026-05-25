import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { RuntimeStore } from './runtime-store.js'

export const isGitRepo = (path: string): boolean => {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const slugifyBranch = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

export const buildWorktreePath = (basePath: string, branch: string): string => {
  const parentDir = dirname(basePath)
  const repoName = basename(basePath)
  const slug = slugifyBranch(branch)
  let candidate = join(parentDir, `${repoName}-${slug}`)
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = join(parentDir, `${repoName}-${slug}-${suffix}`)
    suffix++
  }
  return candidate
}

const tryWorktreeAdd = (
  repoPath: string,
  worktreePath: string,
  branch: string,
  createBranch: boolean
): void => {
  const args = ['-C', repoPath, 'worktree', 'add']
  if (createBranch) {
    args.push('-b', branch, worktreePath)
  } else {
    args.push(worktreePath, branch)
  }
  execFileSync('git', args, { stdio: 'pipe' })
}

export const createWorktree = (
  repoPath: string,
  basePath: string,
  branch: string,
  createBranch: boolean
): string => {
  const maxRetries = 5
  let candidate = basePath
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      tryWorktreeAdd(repoPath, candidate, branch, createBranch)
      return candidate
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists')) {
        candidate = `${basePath}-${attempt + 2}`
        continue
      }
      throw err
    }
  }
  throw new Error(`Failed to create worktree after ${maxRetries} attempts: path conflicts`)
}

export const cloneWorkspaceWorkers = (
  store: RuntimeStore,
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): number => {
  const snapshot = store.getWorkspaceSnapshot(sourceWorkspaceId)
  let count = 0

  for (const agent of snapshot.agents) {
    if (agent.role === 'orchestrator') continue

    const worker = store.addWorker(targetWorkspaceId, {
      name: agent.name,
      role: agent.role,
      description: agent.description,
      ...(agent.roleTemplateName ? { roleTemplateName: agent.roleTemplateName } : {}),
    })

    const launchConfig = store.peekAgentLaunchConfig(sourceWorkspaceId, agent.id)
    if (launchConfig) {
      try {
        store.configureAgentLaunch(targetWorkspaceId, worker.id, {
          command: launchConfig.command,
          ...(launchConfig.args ? { args: launchConfig.args } : {}),
          ...(launchConfig.commandPresetId != null ? { commandPresetId: launchConfig.commandPresetId } : {}),
          ...(launchConfig.interactiveCommand != null ? { interactiveCommand: launchConfig.interactiveCommand } : {}),
          ...(launchConfig.presetAugmentationDisabled != null ? { presetAugmentationDisabled: launchConfig.presetAugmentationDisabled } : {}),
          ...(launchConfig.resumeArgsTemplate != null ? { resumeArgsTemplate: launchConfig.resumeArgsTemplate } : {}),
          ...(launchConfig.sessionIdCapture != null ? { sessionIdCapture: launchConfig.sessionIdCapture } : {}),
        })
      } catch {
        // launch config copy failed — skip, worker still created
      }
    }

    count++
  }

  return count
}

export const copyTasksFile = (sourcePath: string, targetPath: string): boolean => {
  const sourceTasksFile = join(sourcePath, '.hive', 'tasks.md')
  if (!existsSync(sourceTasksFile)) return false

  const targetHiveDir = join(targetPath, '.hive')
  if (!existsSync(targetHiveDir)) {
    mkdirSync(targetHiveDir, { recursive: true })
  }
  copyFileSync(sourceTasksFile, join(targetHiveDir, 'tasks.md'))
  return true
}
