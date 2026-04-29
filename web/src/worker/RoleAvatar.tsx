import type { WorkerRole } from '../../../src/shared/types.js'

type FullRole = WorkerRole | 'orchestrator'

type RoleAvatarProps = {
  role: FullRole
  size?: number
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

export const RoleAvatar = ({ role, size = 32 }: RoleAvatarProps) => {
  const color = colorByRole[role]
  const initials = initialsByRole[role]
  return (
    <span
      data-testid="role-avatar"
      data-role={role}
      className="mono inline-flex shrink-0 items-center justify-center rounded-lg font-semibold"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.34)}px`,
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  )
}
