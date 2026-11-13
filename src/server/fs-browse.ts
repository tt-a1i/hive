import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  dirname as dirnameWin32Path,
  parse as parseWin32Path,
  resolve as resolveWin32Path,
} from 'node:path/win32'

import { WINDOWS_DRIVES_ROOT } from '../shared/fs-browse.js'
import { sanitizePastedPath } from '../shared/path-input.js'
import { getFsBrowseRoot, hasFsBrowseRootOverride, isPathWithinRoot } from './fs-sandbox.js'

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

/**
 * Map a filesystem rejection (from `readdir`, `stat`, etc.) to a string
 * suitable for surfacing in the browse response. The common Windows
 * failure paths — System Volume Information / $Recycle.Bin (EACCES),
 * dangling junctions (EBUSY / EINVAL), paths past MAX_PATH on systems
 * without long-path support (ENAMETOOLONG) — each get a recognizable
 * prefix so the UI does not just show the raw errno.
 */
const formatFilesystemError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Failed to read directory'
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') {
    return `Permission denied: ${error.message}`
  }
  if (code === 'ENAMETOOLONG') {
    return `Path is too long for this filesystem: ${error.message}`
  }
  if (code === 'EBUSY' || code === 'EINVAL') {
    return `Path is busy or unavailable: ${error.message}`
  }
  return error.message
}

const resolveGitDirPath = async (
  repoPath: string,
  sandboxRoot?: string
): Promise<string | null> => {
  const dotGitPath = resolve(repoPath, '.git')
  try {
    const info = await stat(dotGitPath)
    if (info.isDirectory())
      return !sandboxRoot || isPathWithinRoot(sandboxRoot, dotGitPath) ? dotGitPath : null
    if (!info.isFile()) return null

    const text = await readFile(dotGitPath, 'utf8')
    const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? ''
    const match = /^gitdir:\s*(?<path>.+)$/iu.exec(firstLine)
    const gitDirPath = match?.groups?.path?.trim()
    if (!gitDirPath) return null
    const target = isAbsolute(gitDirPath) ? gitDirPath : resolve(repoPath, gitDirPath)
    return !sandboxRoot || isPathWithinRoot(sandboxRoot, target) ? target : null
  } catch {
    return null
  }
}

const detectGitRepository = async (entryPath: string, sandboxRoot?: string): Promise<boolean> =>
  (await resolveGitDirPath(entryPath, sandboxRoot)) !== null

const readCurrentBranch = async (
  repoPath: string,
  sandboxRoot?: string
): Promise<string | null> => {
  const gitDirPath = await resolveGitDirPath(repoPath, sandboxRoot)
  if (!gitDirPath) return null

  try {
    const head = (await readFile(resolve(gitDirPath, 'HEAD'), 'utf8')).split(/\r?\n/u)[0]?.trim()
    const branchRef = head?.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : ''
    return branchRef.length > 0 ? branchRef : null
  } catch {
    return null
  }
}

const isFullWindowsBrowseEnabled = () => process.platform === 'win32' && !hasFsBrowseRootOverride()

const trimTrailingWindowsSeparators = (path: string): string => path.replace(/[\\/]+$/u, '')

const isWindowsRootPath = (path: string): boolean => {
  const resolved = resolveWin32Path(path)
  const parsed = parseWin32Path(resolved)
  return (
    parsed.root.length > 0 &&
    trimTrailingWindowsSeparators(resolved).toLowerCase() ===
      trimTrailingWindowsSeparators(parsed.root).toLowerCase()
  )
}

const listWindowsDriveRoots = async (): Promise<FsBrowseEntry[]> => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const roots = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`
      try {
        const info = await stat(root)
        if (!info.isDirectory()) return null
        return {
          is_dir: true as const,
          is_git_repository: false,
          name: `${letter}:`,
          path: root,
        }
      } catch {
        return null
      }
    })
  )
  return roots.filter((root): root is FsBrowseEntry => root !== null)
}

const browseWindowsDrivesRoot = async (): Promise<FsBrowseResponse> => ({
  current_path: WINDOWS_DRIVES_ROOT,
  entries: await listWindowsDriveRoots(),
  error: null,
  ok: true,
  parent_path: null,
  root_path: WINDOWS_DRIVES_ROOT,
})

const getSandboxParentPath = (rootPath: string, candidate: string): string | null => {
  if (candidate === rootPath) return null
  const rawParent = dirname(candidate)
  return isPathWithinRoot(rootPath, rawParent) ? rawParent : null
}

export const getWindowsBrowseParentPath = (candidate: string): string =>
  isWindowsRootPath(candidate) ? WINDOWS_DRIVES_ROOT : dirnameWin32Path(candidate)

export const getSuggestedWorkspaceNameFromPath = (path: string): string =>
  (path.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(/:$/u, '')

export const browseDirectory = async (requestedPath: string): Promise<FsBrowseResponse> => {
  if (isFullWindowsBrowseEnabled()) {
    return browseWindowsDirectory(requestedPath)
  }

  const rootPath = getFsBrowseRoot()
  const trimmed = sanitizePastedPath(requestedPath)
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
      error: formatFilesystemError(error),
      ok: false,
      parent_path: getSandboxParentPath(rootPath, candidate),
      root_path: rootPath,
    }
  }

  if (!dirStat.isDirectory()) {
    return {
      current_path: candidate,
      entries: [],
      error: 'The specified path is not a directory.',
      ok: false,
      parent_path: getSandboxParentPath(rootPath, candidate),
      root_path: rootPath,
    }
  }

  let rawEntries: Dirent<string>[]
  try {
    rawEntries = await readdir(candidate, { withFileTypes: true })
  } catch (error) {
    // Windows hits this for System Volume Information, $Recycle.Bin,
    // broken junctions, and long paths on hosts without long-path
    // support. Returning ok:false lets the picker surface a readable
    // message instead of crashing the HTTP handler.
    return {
      current_path: candidate,
      entries: [],
      error: formatFilesystemError(error),
      ok: false,
      parent_path: getSandboxParentPath(rootPath, candidate),
      root_path: rootPath,
    }
  }
  const directoryEntries = rawEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolve(candidate, entry.name)
      return {
        is_dir: true as const,
        is_git_repository: await detectGitRepository(entryPath, rootPath),
        name: entry.name,
        path: entryPath,
      }
    })
  )

  return {
    current_path: candidate,
    entries,
    error: null,
    ok: true,
    parent_path: getSandboxParentPath(rootPath, candidate),
    root_path: rootPath,
  }
}

const browseWindowsDirectory = async (requestedPath: string): Promise<FsBrowseResponse> => {
  const trimmed = sanitizePastedPath(requestedPath)
  if (trimmed.length === 0 || trimmed === WINDOWS_DRIVES_ROOT) {
    return browseWindowsDrivesRoot()
  }

  const candidate = resolveWin32Path(trimmed)

  let dirStat: Awaited<ReturnType<typeof stat>>
  try {
    dirStat = await stat(candidate)
  } catch (error) {
    return {
      current_path: candidate,
      entries: [],
      error: formatFilesystemError(error),
      ok: false,
      parent_path: getWindowsBrowseParentPath(candidate),
      root_path: WINDOWS_DRIVES_ROOT,
    }
  }

  if (!dirStat.isDirectory()) {
    return {
      current_path: candidate,
      entries: [],
      error: 'The specified path is not a directory.',
      ok: false,
      parent_path: getWindowsBrowseParentPath(candidate),
      root_path: WINDOWS_DRIVES_ROOT,
    }
  }

  let rawEntries: Dirent<string>[]
  try {
    rawEntries = await readdir(candidate, { withFileTypes: true })
  } catch (error) {
    return {
      current_path: candidate,
      entries: [],
      error: formatFilesystemError(error),
      ok: false,
      parent_path: getWindowsBrowseParentPath(candidate),
      root_path: WINDOWS_DRIVES_ROOT,
    }
  }

  const directoryEntries = rawEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolveWin32Path(candidate, entry.name)
      return {
        is_dir: true as const,
        is_git_repository: await detectGitRepository(entryPath),
        name: entry.name,
        path: entryPath,
      }
    })
  )

  return {
    current_path: candidate,
    entries,
    error: null,
    ok: true,
    parent_path: getWindowsBrowseParentPath(candidate),
    root_path: WINDOWS_DRIVES_ROOT,
  }
}

export interface ProbeDirectoryOptions {
  /**
   * When `true` (default), probe rejects paths outside `$HOME` so the
   * in-browser FS tree can't be tricked into revealing arbitrary disk
   * contents via a hand-crafted path string.
   *
   * When `false`, the sandbox check is skipped — callers who already
   * have a user-authorized path (e.g. paths returned by the OS-native
   * folder picker) must use this so a Windows user picking `D:\projects`
   * isn't rejected just because their `$HOME` lives on `C:`.
   */
  enforceSandbox?: boolean
}

export const probeDirectory = async (
  requestedPath: string,
  options: ProbeDirectoryOptions = {}
): Promise<FsProbeResponse> => {
  const enforceSandbox = options.enforceSandbox ?? true
  const fullWindowsBrowse = isFullWindowsBrowseEnabled()
  const requested = sanitizePastedPath(requestedPath)
  if (requested === WINDOWS_DRIVES_ROOT) {
    return {
      current_branch: null,
      exists: false,
      is_dir: false,
      is_git_repository: false,
      ok: false,
      path: '',
      suggested_name: '',
    }
  }
  const rootPath = getFsBrowseRoot()
  const candidate =
    enforceSandbox && !fullWindowsBrowse ? resolve(rootPath, requested) : resolve(requested)
  const base = {
    current_branch: null,
    exists: false,
    is_dir: false,
    is_git_repository: false,
    ok: false,
    path: candidate,
    suggested_name: getSuggestedWorkspaceNameFromPath(candidate),
  }

  if (enforceSandbox && !fullWindowsBrowse && !isPathWithinRoot(rootPath, candidate)) {
    return base
  }

  try {
    const info = await stat(candidate)
    if (!info.isDirectory()) {
      return { ...base, exists: true, is_dir: false, ok: true }
    }
    const sandboxRoot = enforceSandbox && !fullWindowsBrowse ? rootPath : undefined
    const is_git_repository = await detectGitRepository(candidate, sandboxRoot)
    const current_branch = is_git_repository
      ? await readCurrentBranch(candidate, sandboxRoot)
      : null
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
