import type { WorkerRole } from '../../../src/shared/types.js'
import { Avatar } from '../ui/Avatar.js'

type StatusRing = 'working' | 'idle' | 'stopped' | 'none'

type CliAgentAvatarProps = {
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

interface LogoSpec {
  src: string
  /**
   * Pale background painted behind the logo. Without this, OpenCode's black/grey
   * pixel mark disappears on dark surfaces; Codex's mono knot loses contrast
   * too. A near-white background lets all four logos read at any theme.
   */
  surface: string
}

const LOGO_REGISTRY: Record<string, LogoSpec> = {
  claude: { src: '/cli-icons/claude.png', surface: '#f7f5f2' },
  codex: { src: '/cli-icons/codex.png', surface: '#f4f4f4' },
  gemini: { src: '/cli-icons/gemini.png', surface: '#f4f4f4' },
  opencode: { src: '/cli-icons/opencode.svg', surface: '#f4f4f4' },
}

const ringColorByStatus: Record<Exclude<StatusRing, 'none'>, string> = {
  working: 'var(--status-green)',
  idle: 'var(--text-tertiary)',
  stopped: 'var(--status-red)',
}

const getKnownLogo = (commandPresetId: string | undefined): LogoSpec | null =>
  commandPresetId ? (LOGO_REGISTRY[commandPresetId] ?? null) : null

const initialsByRole: Record<WorkerRole, string> = {
  coder: 'Co',
  custom: 'Cu',
  reviewer: 'Re',
  tester: 'Te',
}

const colorByRole: Record<WorkerRole, string> = {
  coder: 'var(--status-blue)',
  custom: 'var(--text-secondary)',
  reviewer: 'var(--status-purple)',
  tester: 'var(--status-orange)',
}

/**
 * Shows the CLI agent's brand logo when we can map the worker to a built-in
 * preset; otherwise delegates to {@link RoleAvatar} so we never duplicate role
 * tint / initials tables. Geometry mirrors `Avatar` (square + small radius +
 * two-band status halo via box-shadow) so cards mixing the two avatar kinds
 * stay visually aligned.
 */
export const CliAgentAvatar = ({
  commandPresetId,
  workerRole,
  size = 32,
  statusRing = 'none',
}: CliAgentAvatarProps) => {
  const logo = getKnownLogo(commandPresetId)
  if (!logo) {
    return (
      <Avatar
        size={size}
        color={colorByRole[workerRole]}
        fontRatio={0.34}
        mono
        ringColor={statusRing === 'none' ? null : ringColorByStatus[statusRing]}
        ringSurface="var(--bg-2)"
        testId="role-avatar"
        data={{ role: workerRole, 'status-ring': statusRing }}
      >
        {initialsByRole[workerRole]}
      </Avatar>
    )
  }

  const ring = statusRing === 'none' ? null : ringColorByStatus[statusRing]
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
        width={innerSize}
        height={innerSize}
        style={{ width: `${innerSize}px`, height: `${innerSize}px`, objectFit: 'contain' }}
      />
    </span>
  )
}
