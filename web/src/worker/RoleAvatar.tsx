import type { WorkerRole } from '../../../src/shared/types.js'
import { Avatar } from '../ui/Avatar.js'

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

export const RoleAvatar = ({ role, size = 32, statusRing = 'none' }: RoleAvatarProps) => (
  <Avatar
    size={size}
    color={colorByRole[role]}
    fontRatio={0.34}
    mono
    ringColor={statusRing === 'none' ? null : ringColorByStatus[statusRing]}
    ringSurface="var(--bg-2)"
    testId="role-avatar"
    data={{ role, 'status-ring': statusRing }}
  >
    {initialsByRole[role]}
  </Avatar>
)
