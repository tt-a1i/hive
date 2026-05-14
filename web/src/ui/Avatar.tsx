import type { CSSProperties, ReactNode } from 'react'

type AvatarProps = {
  /** Edge length in px (square). */
  size: number
  /** Initials or single glyph rendered inside. */
  children: ReactNode
  /** Tint color (any valid CSS color or var). Drives bg + border + text. */
  color: string
  /** Font-size as a fraction of `size`. WorkspaceAvatar uses 0.45 for a
   *  single letter; RoleAvatar uses 0.34 for two letters. */
  fontRatio?: number
  /** Outer status ring color, or null for no ring. */
  ringColor?: string | null
  /** Background color of the gap between avatar and ring (so the ring
   *  reads as a halo, not a thickened border). Defaults to bg-1. */
  ringSurface?: string
  /** Render content with the DM Mono font. */
  mono?: boolean
  /** Absolutely-positioned overlay (badge / status dot) — rendered after
   *  the initials inside the avatar's positioning context. */
  decoration?: ReactNode
  /** Forwarded testid. */
  testId?: string
  /** Forwarded as `data-*` attributes verbatim. */
  data?: Record<string, string | undefined>
  className?: string
  style?: CSSProperties
}

/**
 * Shared avatar primitive used by WorkspaceAvatar (1-letter initial, hash-
 * derived hue) and RoleAvatar (2-letter role tag, role-derived hue). The
 * tint recipe — `color-mix 14%` bg + `color-mix 35%` border + the source
 * color as foreground — and the optional 2-band status halo are the parts
 * that needed to stay consistent across both surfaces. Everything specific
 * (badges, working dots, computed initials) stays in the consumer.
 */
export const Avatar = ({
  size,
  children,
  color,
  fontRatio = 0.4,
  ringColor = null,
  ringSurface = 'var(--bg-1)',
  mono = false,
  decoration,
  testId,
  data,
  className = '',
  style = {},
}: AvatarProps) => {
  const dataAttrs: Record<string, string> = {}
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) dataAttrs[`data-${key}`] = value
    }
  }
  return (
    <span
      data-testid={testId}
      {...dataAttrs}
      className={`relative inline-flex shrink-0 items-center justify-center rounded font-semibold ${
        mono ? 'mono ' : ''
      }${className}`.trim()}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * fontRatio)}px`,
        color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
        boxShadow: ringColor ? `0 0 0 2px ${ringSurface}, 0 0 0 4px ${ringColor}` : undefined,
        ...style,
      }}
      aria-hidden
    >
      {children}
      {decoration}
    </span>
  )
}
