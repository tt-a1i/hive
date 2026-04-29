import type { WorkerRole } from '../../../src/shared/types.js'

type FullRole = WorkerRole | 'orchestrator'

type StatusRing = 'working' | 'idle' | 'stopped' | 'none'

type RoleAvatarProps = {
  role: FullRole
  size?: number
  /** Optional ring around the avatar matching agent status. */
  statusRing?: StatusRing
}

const initialsByRole: Record<FullRole, string> = {
  orchestrator: 'Or',
  coder: 'Co',
  reviewer: 'Re',
  tester: 'Te',
  custom: 'Cu',
}

const colorByRole: Record<FullRole, string> = {
  orchestrator: 'var(--accent)',
  coder: 'var(--status-blue)',
  reviewer: 'var(--status-purple)',
  tester: 'var(--status-orange)',
  custom: 'var(--text-secondary)',
}

const ringColorByStatus: Record<Exclude<StatusRing, 'none'>, string> = {
  working: 'var(--status-green)',
  idle: 'var(--text-tertiary)',
  stopped: 'var(--status-red)',
}

export const RoleAvatar = ({ role, size = 32, statusRing = 'none' }: RoleAvatarProps) => {
  const color = colorByRole[role]
  const initials = initialsByRole[role]
  const ringColor = statusRing === 'none' ? null : ringColorByStatus[statusRing]
  return (
    <span
      data-testid="role-avatar"
      data-role={role}
      data-status-ring={statusRing}
      className="mono relative inline-flex shrink-0 items-center justify-center rounded-lg font-semibold"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.34)}px`,
        color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
        boxShadow: ringColor ? `0 0 0 2px var(--bg-2), 0 0 0 3px ${ringColor}` : undefined,
      }}
      aria-hidden
    >
      {initials}
    </span>
  )
}
