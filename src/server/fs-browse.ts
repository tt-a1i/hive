import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { getFsBrowseRoot, isPathWithinRoot } from './fs-sandbox.js'

const execFileP = promisify(execFile)
const GIT_BRANCH_TIMEOUT_MS = 800

export interface FsBrowseEntry {
  is_dir: true
  is_git_repository: boolean
  name: string
  path: string
}

export interface FsBrowseResponse {
  current_path: string
  entries: FsBrowseEntry[]
  error: string | null
  ok: boolean
  parent_path: string | null
  root_path: string
}

export interface FsProbeResponse {
  current_branch: string | null
  exists: boolean
  is_dir: boolean
  is_git_repository: boolean
  ok: boolean
  path: string
  suggested_name: string
}

const detectGitRepository = async (entryPath: string): Promise<boolean> => {
  try {
    const info = await stat(resolve(entryPath, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

const readCurrentBranch = async (repoPath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        timeout: GIT_BRANCH_TIMEOUT_MS,
        windowsHide: true,
      }
    )
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

export const browseDirectory = async (requestedPath: string): Promise<FsBrowseResponse> => {
  const rootPath = getFsBrowseRoot()
  const trimmed = requestedPath.trim()
  const candidate = trimmed.length === 0 ? rootPath : resolve(rootPath, trimmed)

  if (!isPathWithinRoot(rootPath, candidate)) {
    return {
      current_path: rootPath,
      entries: [],
      error: 'Access denied: path is outside the browse root.',
      ok: false,
      parent_path: null,
      root_path: rootPath,
    }
  }

  let dirStat: Awaited<ReturnType<typeof stat>>
  try {
    dirStat = await stat(candidate)
  } catch (error) {
    return {
      current_path: candidate,
      entries: [],
      error: error instanceof Error ? error.message : 'Failed to stat directory',
      ok: false,
      parent_path: null,
      root_path: rootPath,
    }
  }

  if (!dirStat.isDirectory()) {
    return {
      current_path: candidate,
      entries: [],
      error: 'The specified path is not a directory.',
      ok: false,
      parent_path: null,
      root_path: rootPath,
    }
  }

  const rawEntries = await readdir(candidate, { withFileTypes: true })
  const directoryEntries = rawEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolve(candidate, entry.name)
      return {
        is_dir: true as const,
        is_git_repository: await detectGitRepository(entryPath),
        name: entry.name,
        path: entryPath,
      }
    })
  )

  const isAtRoot = candidate === rootPath
  const rawParent = dirname(candidate)
  const parentIsWithinRoot = isPathWithinRoot(rootPath, rawParent)
  const parent_path = isAtRoot ? null : parentIsWithinRoot ? rawParent : null

  return {
    current_path: candidate,
    entries,
    error: null,
    ok: true,
    parent_path,
    root_path: rootPath,
  }
}

export const probeDirectory = async (requestedPath: string): Promise<FsProbeResponse> => {
  const rootPath = getFsBrowseRoot()
  const candidate = resolve(rootPath, requestedPath.trim())
  const base = {
    current_branch: null,
    exists: false,
    is_dir: false,
    is_git_repository: false,
    ok: false,
    path: candidate,
    suggested_name: candidate.split(/[\\/]/).filter(Boolean).pop() ?? '',
  }

  if (!isPathWithinRoot(rootPath, candidate)) {
    return base
  }

  try {
    const info = await stat(candidate)
    if (!info.isDirectory()) {
      return { ...base, exists: true, is_dir: false, ok: true }
    }
    const is_git_repository = await detectGitRepository(candidate)
    const current_branch = is_git_repository ? await readCurrentBranch(candidate) : null
    return {
      current_branch,
      exists: true,
      is_dir: true,
      is_git_repository,
      ok: true,
      path: candidate,
      suggested_name: base.suggested_name,
    }
  } catch {
    return base
  }
}
