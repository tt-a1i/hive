import { Avatar } from '../ui/Avatar.js'
import { deriveInitial, pickWorkspaceColor } from './derive-workspace-color.js'

type WorkspaceAvatarProps = {
  workspaceId: string
  name: string
  isActive: boolean
  /** Surfaces a green pulsing dot when at least one worker is `working`. */
  working?: boolean
  /** When set, replaces the working dot with a numeric badge — useful when
   *  multiple workers are running and the user wants to glance the load. */
  workingCount?: number
  size?: number
}

/**
 * Discord/Slack-style workspace avatar used by the sidebar in compact mode.
 * Pairs `pickWorkspaceColor` (deterministic from `workspace.id`) with a single
 * uppercased initial derived from `name`. Active state is expressed as a 2-px
 * accent ring; the working flag pins a `.status-dot--working` indicator at
 * the bottom-right corner.
 */
export const WorkspaceAvatar = ({
  workspaceId,
  name,
  isActive,
  working,
  workingCount,
  size = 32,
}: WorkspaceAvatarProps) => {
  const { token: color, label } = pickWorkspaceColor(workspaceId)
  const initial = deriveInitial(name)
  const badgeCount = workingCount && workingCount > 1 ? workingCount : null
  return (
    <Avatar
      size={size}
      color={color}
      fontRatio={0.45}
      ringColor={isActive ? color : null}
      testId="workspace-avatar"
      data={{
        'workspace-id': workspaceId,
        active: isActive ? 'true' : undefined,
        'color-label': label,
      }}
      decoration={
        badgeCount !== null ? (
          <span
            className="absolute flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 font-medium text-xs tabular-nums leading-none"
            style={{
              right: '-4px',
              bottom: '-4px',
              background: 'var(--status-green)',
              color: '#0a1f0a',
              boxShadow: '0 0 0 2px var(--bg-1)',
            }}
            data-testid="workspace-avatar-working-count"
            aria-hidden
          >
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        ) : working ? (
          <span
            className="status-dot status-dot--working absolute"
            style={{
              right: '-2px',
              bottom: '-2px',
              boxShadow: '0 0 0 2px var(--bg-1)',
            }}
            aria-hidden
          />
        ) : null
      }
    >
      {initial}
    </Avatar>
  )
}
