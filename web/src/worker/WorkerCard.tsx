import type { TeamListItem } from '../../../src/shared/types.js'
import { getRolePresentation } from './role-presentation.js'

type WorkerCardProps = {
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

const statusDisplay = (worker: TeamListItem) => {
  if (worker.status === 'stopped') {
    return { bullet: '○', dotClass: 'dot', label: 'stopped', tone: 'var(--status-red)' }
  }
  if (worker.pendingTaskCount > 0) {
    return {
      bullet: '●',
      dotClass: 'dot pulse-orange',
      label: 'queued',
      tone: 'var(--status-orange)',
    }
  }
  return { bullet: '○', dotClass: 'dot', label: 'idle', tone: 'var(--text-tertiary)' }
}

export const WorkerCard = ({ onClick, worker }: WorkerCardProps) => {
  const role = getRolePresentation(worker.role)
  const status = statusDisplay(worker)
  return (
    <button
      type="button"
      onClick={() => onClick(worker)}
      aria-label={`Open ${worker.name}`}
      className="card card--interactive p-4 text-left"
      data-testid={`worker-card-${worker.id}`}
    >
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none" aria-hidden>
          {role.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-pri">{worker.name}</span>
            <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
          </div>
          <div className="mono mt-0.5 text-[11px] text-ter">{worker.role}</div>
        </div>
        <span
          className={status.dotClass}
          style={status.dotClass === 'dot' ? { background: status.tone } : undefined}
          title={status.label}
        />
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs">
        <span style={{ color: status.tone }} aria-hidden>
          {status.bullet}
        </span>
        <span className="text-pri">{status.label}</span>
      </div>
      <div className="line-clamp-2 mt-2 text-xs text-sec">
        {worker.pendingTaskCount > 0 ? `${worker.pendingTaskCount} pending task(s)` : '尚未派单'}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-ter">
        <span>队列: {worker.pendingTaskCount}</span>
        <span>—</span>
      </div>
    </button>
  )
}
