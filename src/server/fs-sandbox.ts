import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Root directory the FS-browse API is allowed to reveal. We sandbox to
 * `$HOME` (override via `HIVE_FS_BROWSE_ROOT` for tests). Anything outside
 * this prefix is rejected before readdir/stat even runs.
 */
export const getFsBrowseRoot = (): string => {
  const override = process.env.HIVE_FS_BROWSE_ROOT
  return override && override.length > 0 ? resolve(override) : resolve(homedir())
}

/**
 * True when `candidatePath` is `rootPath` itself or a descendant of it.
 * Uses `path.relative` + separator check so Windows back-slashes and drive
 * boundaries are handled correctly — identical shape to kanban's
 * isPathWithinRoot so the semantics match a project we already trust.
 */
export const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const resolvedRoot = resolve(rootPath)
  const resolvedCandidate = resolve(candidatePath)
  if (resolvedCandidate === resolvedRoot) return true
  const rel = relative(resolvedRoot, resolvedCandidate)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
