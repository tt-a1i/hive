import type { TeamListItem, WorkerRole } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerQueue, presentWorkerStatus } from './worker-status.js'

type WorkerCardProps = {
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

const roleStripeColor: Record<WorkerRole, string> = {
  coder: 'var(--status-blue)',
  reviewer: 'var(--status-purple)',
  tester: 'var(--status-orange)',
  custom: 'var(--text-tertiary)',
}

const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 6)

export const WorkerCard = ({ onClick, worker }: WorkerCardProps) => {
  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const queue = presentWorkerQueue(worker)
  const stripe = roleStripeColor[worker.role]
  return (
    <button
      type="button"
      onClick={() => onClick(worker)}
      aria-label={`Open ${worker.name}`}
      className="card card--interactive relative w-full overflow-hidden p-0 text-left"
      data-testid={`worker-card-${worker.id}`}
      data-status={status.kind}
    >
      {/* Role-color left stripe — gradient falloff + right-side soft glow so
          the role tint reads as light leaking into the card, not a hard bar. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{
          background: `linear-gradient(180deg, ${stripe} 0%, color-mix(in oklab, ${stripe} 55%, transparent) 100%)`,
          boxShadow: `2px 0 10px -2px color-mix(in oklab, ${stripe} 35%, transparent)`,
        }}
      />

      <div className="flex items-start gap-3 px-4 py-3.5">
        <RoleAvatar role={worker.role} size={36} statusRing={status.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-pri">{worker.name}</span>
            <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
            <span className="mono shrink-0 text-[10px] text-ter" title={`agent id ${worker.id}`}>
              {shortId(worker.id)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`status-pill status-pill--${status.kind}`}
              role="status"
              title={status.label}
            >
              <span className={status.dotClass} aria-hidden />
              {status.label}
            </span>
          </div>
        </div>
        {queue ? (
          <span
            className="queue-badge shrink-0"
            title={`${queue.count} pending dispatch(es) — independent of PTY state`}
          >
            <span className="status-dot status-dot--queued" aria-hidden />
            {queue.label}
          </span>
        ) : null}
      </div>
    </button>
  )
}
