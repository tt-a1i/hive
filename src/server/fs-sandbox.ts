import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { realpathNative } from './path-canonicalization.js'

/**
 * Root directory the FS-browse API is allowed to reveal when sandboxing is
 * enabled. Tests and remote/headless setups can set `HIVE_FS_BROWSE_ROOT`.
 * Normal Windows runs skip this sandbox root and browse from the virtual
 * "This PC" drive list; POSIX sandboxed browsing defaults to `$HOME`.
 */
export const getFsBrowseRoot = (): string => {
  const override = process.env.HIVE_FS_BROWSE_ROOT
  const root = override && override.length > 0 ? resolve(override) : resolve(homedir())
  try {
    return realpathNative(root)
  } catch {
    return root
  }
}

export const hasFsBrowseRootOverride = (): boolean =>
  (process.env.HIVE_FS_BROWSE_ROOT ?? '').length > 0

const isResolvedPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  if (candidatePath === rootPath) return true
  const rel = relative(rootPath, candidatePath)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * True when `candidatePath` is `rootPath` itself or a descendant of it.
 * Uses `path.relative` + separator check so Windows back-slashes and drive
 * boundaries are handled correctly — identical shape to kanban's
 * isPathWithinRoot so the semantics match a project we already trust.
 */
export const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const lexicalRoot = resolve(rootPath)
  const lexicalCandidate = resolve(candidatePath)
  let resolvedRoot = lexicalRoot
  let resolvedCandidate = lexicalCandidate
  try {
    resolvedRoot = realpathNative(resolvedRoot)
  } catch {
    // Missing / inaccessible roots are handled by the caller's readdir/stat path.
  }
  let ancestor = lexicalCandidate
  const suffix: string[] = []
  while (true) {
    try {
      resolvedCandidate = resolve(realpathNative(ancestor), ...suffix)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      try {
        lstatSync(ancestor)
        return false // A dangling symlink is not a missing path.
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  }
  return isResolvedPathWithinRoot(resolvedRoot, resolvedCandidate)
}
