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
  return (
    <button
      type="button"
      onClick={() => onClick(worker)}
      aria-label={`Open ${worker.name}`}
      className="card card--interactive relative w-full overflow-hidden p-0 text-left"
      data-testid={`worker-card-${worker.id}`}
      data-status={status.kind}
    >
      {/* Role-color left stripe — gives each card a visual identity tied to role. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: roleStripeColor[worker.role] }}
      />

      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <RoleAvatar role={worker.role} size={40} statusRing={status.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-pri">{worker.name}</span>
            <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
          </div>
          <div
            className={`mt-1.5 inline-flex items-center gap-1.5 text-[11px] ${
              status.kind === 'working'
                ? 'text-status-green'
                : status.kind === 'stopped'
                  ? 'text-status-red'
                  : 'text-ter'
            }`}
            role="status"
            title={status.label}
          >
            <span className={status.dotClass} aria-hidden />
            {status.label}
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

      <div
        className="mono flex items-center gap-3 border-t px-4 py-2 text-[10px] text-ter"
        style={{ borderColor: 'var(--border)' }}
      >
        <span title={`agent id ${worker.id}`}>
          id <span className="text-sec">{shortId(worker.id)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          queue <span className="text-sec">{worker.pendingTaskCount}</span>
        </span>
      </div>
    </button>
  )
}
