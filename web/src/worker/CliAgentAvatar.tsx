import type { ReactNode } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'

type StatusRing = 'working' | 'idle' | 'stopped' | 'none'

type CliAgentAvatarProps = {
  /** User-uploaded avatar data URL. Overrides the default CLI logo / role icon when present. */
  customAvatar?: string | null | undefined
  /**
   * Built-in preset id from the team list payload. Known ids resolve to a
   * brand logo; anything else (custom commands, missing launch config, future
   * presets the UI hasn't been taught about yet) falls back to the role-letter
   * avatar so old data never renders blank.
   */
  commandPresetId?: string | undefined
  /** Used by the fallback path only. */
  workerRole: WorkerRole
  size?: number
  statusRing?: StatusRing
}

type CliAgentLogoProps = {
  commandPresetId?: string | undefined
  fallback?: ReactNode
  size?: number
  testId?: string
}

interface LogoSpec {
  src: string
  /**
   * Pale background painted behind the logo. Without this, OpenCode's black/grey
   * pixel mark disappears on dark surfaces; Codex's mono knot loses contrast
   * too. A near-white background lets the mono/dark logos read at any theme.
   */
  surface: string
}

const LOGO_REGISTRY: Record<string, LogoSpec> = {
  agy: { src: '/cli-icons/agy.png', surface: '#f4f4f4' },
  claude: { src: '/cli-icons/claude.png', surface: '#f7f5f2' },
  codex: { src: '/cli-icons/codex.png', surface: '#f4f4f4' },
  cursor: { src: '/cli-icons/cursor.ico', surface: '#ffffff' },
  gemini: { src: '/cli-icons/gemini.png', surface: '#f4f4f4' },
  grok: { src: '/cli-icons/grok.ico', surface: '#ffffff' },
  hermes: { src: '/cli-icons/hermes.png', surface: '#ffffff' },
  kimi: { src: '/cli-icons/kimi.png', surface: '#f4f8ff' },
  opencode: { src: '/cli-icons/opencode.svg', surface: '#f4f4f4' },
  pi: { src: '/cli-icons/pi.svg', surface: '#1a1a1a' },
  qwen: { src: '/cli-icons/qwen.png', surface: '#f4f8ff' },
}

const ringColorByStatus: Record<Exclude<StatusRing, 'none'>, string> = {
  working: 'var(--status-green)',
  idle: 'var(--text-tertiary)',
  stopped: 'var(--status-red)',
}

const getKnownLogo = (commandPresetId: string | undefined): LogoSpec | null =>
  commandPresetId ? (LOGO_REGISTRY[commandPresetId] ?? null) : null

export const CliAgentLogo = ({
  commandPresetId,
  fallback = null,
  size = 20,
  testId = 'cli-agent-logo',
}: CliAgentLogoProps) => {
  const logo = getKnownLogo(commandPresetId)
  if (!logo) return fallback
  const innerSize = Math.round(size * 0.78)
  return (
    <span
      data-testid={testId}
      data-command-preset={commandPresetId}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded"
      aria-hidden
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: logo.surface,
        border: '1px solid color-mix(in oklab, var(--text-primary) 12%, transparent)',
      }}
    >
      <img
        src={logo.src}
        alt=""
        decoding="sync"
        width={innerSize}
        height={innerSize}
        style={{ width: `${innerSize}px`, height: `${innerSize}px`, objectFit: 'contain' }}
      />
    </span>
  )
}

/**
 * Shows the CLI agent's brand logo when we can map the worker to a built-in
 * preset; otherwise delegates to {@link RoleAvatar} so we never duplicate role
 * tint / glyph tables. Geometry mirrors `Avatar` (square + small radius +
 * two-band status halo via box-shadow) so cards mixing the two avatar kinds
 * stay visually aligned.
 */
export const CliAgentAvatar = ({
  commandPresetId,
  customAvatar,
  workerRole,
  size = 32,
  statusRing = 'none',
}: CliAgentAvatarProps) => {
  const ring = statusRing === 'none' ? null : ringColorByStatus[statusRing]
  if (customAvatar) {
    return (
      <span
        data-testid="custom-agent-avatar"
        data-status-ring={statusRing}
        className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded"
        aria-hidden
        style={{
          width: `${size}px`,
          height: `${size}px`,
          background: 'var(--bg-2)',
          border: '1px solid color-mix(in oklab, var(--text-primary) 12%, transparent)',
          boxShadow: ring ? `0 0 0 2px var(--bg-1), 0 0 0 4px ${ring}` : undefined,
        }}
      >
        <img
          src={customAvatar}
          alt=""
          decoding="async"
          width={size}
          height={size}
          style={{ width: `${size}px`, height: `${size}px`, objectFit: 'cover' }}
        />
      </span>
    )
  }

  const logo = getKnownLogo(commandPresetId)
  if (!logo) {
    return <RoleAvatar role={workerRole} size={size} statusRing={statusRing} />
  }

  const innerSize = Math.round(size * 0.78)
  return (
    <span
      data-testid="cli-agent-avatar"
      data-command-preset={commandPresetId}
      data-status-ring={statusRing}
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded"
      aria-hidden
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: logo.surface,
        border: '1px solid color-mix(in oklab, var(--text-primary) 12%, transparent)',
        boxShadow: ring ? `0 0 0 2px var(--bg-1), 0 0 0 4px ${ring}` : undefined,
      }}
    >
      <img
        src={logo.src}
        alt=""
        decoding="sync"
        width={innerSize}
        height={innerSize}
        style={{ width: `${innerSize}px`, height: `${innerSize}px`, objectFit: 'contain' }}
      />
    </span>
  )
}
