export interface BreadcrumbSegment {
  label: string
  path: string
}

const rootLabel = (rootPath: string): string => {
  const trimmed = rootPath.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1]
  return last ? `~ (${last})` : rootPath
}

export const buildBreadcrumbs = (currentPath: string, rootPath: string): BreadcrumbSegment[] => {
  if (!rootPath || !currentPath) return []
  const segments: BreadcrumbSegment[] = [{ label: rootLabel(rootPath), path: rootPath }]
  if (currentPath === rootPath) return segments

  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
  const relative = currentPath.startsWith(normalizedRoot)
    ? currentPath.slice(normalizedRoot.length).replace(/^[\\/]+/, '')
    : ''
  if (!relative) return segments

  const parts = relative.split(/[\\/]/).filter(Boolean)
  let accumulated = normalizedRoot
  for (const part of parts) {
    accumulated = `${accumulated}/${part}`
    segments.push({ label: part, path: accumulated })
  }
  return segments
}
