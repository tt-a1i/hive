/**
 * Deterministic workspace color/initial derivation.
 *
 * Compact-mode workspace avatars derive their color from `workspace.id` (not
 * `name`) so renaming a workspace does not shuffle its visual identity.
 *
 * The palette intentionally excludes `--status-red` to avoid users reading the
 * avatar tint as an error indicator.
 */

export interface WorkspaceColor {
  /** CSS color value referencing a design token. */
  token: string
  /** Short label for debugging / data-attribute introspection in tests. */
  label: string
}

const PALETTE: readonly WorkspaceColor[] = [
  { token: 'var(--accent)', label: 'accent' },
  { token: 'var(--status-blue)', label: 'blue' },
  { token: 'var(--status-purple)', label: 'purple' },
  { token: 'var(--status-orange)', label: 'orange' },
  { token: 'var(--status-green)', label: 'green' },
  { token: 'var(--status-gold)', label: 'gold' },
]

export const pickWorkspaceColor = (workspaceId: string): WorkspaceColor => {
  let hash = 0
  for (let i = 0; i < workspaceId.length; i += 1) {
    hash = (hash * 31 + workspaceId.charCodeAt(i)) | 0
  }
  const index = Math.abs(hash) % PALETTE.length
  // Non-null: PALETTE.length > 0 and index is bounded by modulo.
  return PALETTE[index] as WorkspaceColor
}

export const deriveInitial = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  const codePoint = trimmed.codePointAt(0)
  if (codePoint === undefined) return '?'
  return String.fromCodePoint(codePoint).toUpperCase()
}
