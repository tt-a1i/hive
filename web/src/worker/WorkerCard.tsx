import type { TeamListItem } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerQueue, presentWorkerStatus } from './worker-status.js'

type WorkerCardProps = {
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

export const WorkerCard = ({ onClick, worker }: WorkerCardProps) => {
  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const queue = presentWorkerQueue(worker)
  return (
    <button
      type="button"
      onClick={() => onClick(worker)}
      aria-label={`Open ${worker.name}`}
      className="card card--interactive p-4 text-left"
      data-testid={`worker-card-${worker.id}`}
      data-status={status.kind}
    >
      <div className="flex items-start gap-3">
        <RoleAvatar role={worker.role} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-pri">{worker.name}</span>
            <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
          </div>
          <div className="mono mt-0.5 truncate text-[11px] text-ter">{worker.role}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`status-pill status-pill--${status.kind}`}
            title={status.label}
            role="status"
          >
            <span className={status.dotClass} aria-hidden />
            {status.label}
          </span>
          {queue ? (
            <span
              className="queue-badge"
              title={`${queue.count} pending dispatch(es) — independent of PTY state`}
            >
              <span className="status-dot status-dot--queued" aria-hidden />
              {queue.label}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}
