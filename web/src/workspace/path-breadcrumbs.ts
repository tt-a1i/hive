import { WINDOWS_DRIVES_ROOT } from '../../../src/shared/fs-browse.js'
import { detectPathSeparator } from './path-join.js'

export interface BreadcrumbSegment {
  label: string
  path: string
}

const rootLabel = (rootPath: string, virtualRootLabel: string): string => {
  if (rootPath === WINDOWS_DRIVES_ROOT) return virtualRootLabel
  const trimmed = rootPath.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1]
  return last ? `~ (${last})` : rootPath
}

const trimTrailingSeparators = (path: string): string => path.replace(/[\\/]+$/u, '') || path

const isWindowsDrivePath = (path: string): boolean => /^[A-Za-z]:($|[\\/])/u.test(path)

const isWindowsBackslashUncPath = (path: string): boolean => /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path)

const isSameWindowsPathFamily = (left: string, right: string): boolean =>
  (isWindowsDrivePath(left) && isWindowsDrivePath(right)) ||
  (isWindowsBackslashUncPath(left) && isWindowsBackslashUncPath(right))

const parseWindowsUncPath = (path: string) => {
  const match = /^(?:\\\\|\/\/)(?<server>[^\\/]+)[\\/](?<share>[^\\/]+)[\\/]*(?<rest>.*)$/u.exec(
    path
  )
  if (!match?.groups) return null
  const { server, share, rest = '' } = match.groups
  const root = `\\\\${server}\\${share}\\`
  return { label: `\\\\${server}\\${share}`, rest, root }
}

const pathEquals = (left: string, right: string): boolean => {
  const a = trimTrailingSeparators(left)
  const b = trimTrailingSeparators(right)
  return isSameWindowsPathFamily(a, b) ? a.toLowerCase() === b.toLowerCase() : a === b
}

const pathStartsWithRoot = (currentPath: string, rootPath: string): boolean => {
  const current = trimTrailingSeparators(currentPath)
  const root = trimTrailingSeparators(rootPath)
  if (root === '/' || root === '\\') return current.startsWith(root)
  const windowsComparison = isSameWindowsPathFamily(current, root)
  const comparableCurrent = windowsComparison ? current.toLowerCase() : current
  const comparableRoot = windowsComparison ? root.toLowerCase() : root
  if (comparableCurrent === comparableRoot) return true
  if (!comparableCurrent.startsWith(comparableRoot)) return false
  const boundary = comparableCurrent[comparableRoot.length]
  return boundary === '/' || boundary === '\\'
}

export const buildBreadcrumbs = (
  currentPath: string,
  rootPath: string,
  virtualRootLabel = 'This PC'
): BreadcrumbSegment[] => {
  if (!rootPath || !currentPath) return []
  const segments: BreadcrumbSegment[] = [
    { label: rootLabel(rootPath, virtualRootLabel), path: rootPath },
  ]
  if (pathEquals(currentPath, rootPath)) return segments

  if (rootPath === WINDOWS_DRIVES_ROOT) {
    const unc = parseWindowsUncPath(currentPath)
    if (unc) {
      segments.push({ label: unc.label, path: unc.root })
      const parts = unc.rest.split(/[\\/]/).filter(Boolean)
      let accumulated = unc.root.replace(/[\\/]+$/, '')
      for (const part of parts) {
        accumulated = `${accumulated}\\${part}`
        segments.push({ label: part, path: accumulated })
      }
      return segments
    }

    const match = /^(?<drive>[A-Za-z]:)[\\/]*(?<rest>.*)$/u.exec(currentPath)
    const drive = match?.groups?.drive
    if (!drive) return segments
    const driveRoot = `${drive}\\`
    segments.push({ label: drive, path: driveRoot })
    const parts = (match.groups?.rest ?? '').split(/[\\/]/).filter(Boolean)
    let accumulated = driveRoot.replace(/[\\/]+$/, '')
    for (const part of parts) {
      accumulated = `${accumulated}\\${part}`
      segments.push({ label: part, path: accumulated })
    }
    return segments
  }

  const normalizedRoot = trimTrailingSeparators(rootPath)
  const relative = pathStartsWithRoot(currentPath, normalizedRoot)
    ? currentPath.slice(normalizedRoot.length).replace(/^[\\/]+/, '')
    : ''
  if (!relative) return segments

  // Sniff the root's separator so the assembled child paths match it
  // (avoids `C:\repo/sub/dir` for a Windows root that happened to use
  // backslashes).
  const sep = detectPathSeparator(normalizedRoot)
  const parts = relative.split(/[\\/]/).filter(Boolean)
  let accumulated = normalizedRoot
  for (const part of parts) {
    accumulated = `${accumulated}${sep}${part}`
    segments.push({ label: part, path: accumulated })
  }
  return segments
}
