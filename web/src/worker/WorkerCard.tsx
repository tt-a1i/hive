import { Pencil, Play, Trash2 } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

const pillToneByStatus: Record<WorkerStatusKind, string> = {
  working: 'pill--green',
  idle: 'pill--ghost',
  stopped: 'pill--red',
}

export type WorkerCardActionKind = 'start' | 'rename' | 'delete'

type WorkerCardProps = {
  hasRun: boolean
  isPending?: boolean
  onAction?: (kind: WorkerCardActionKind, worker: TeamListItem) => void
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

/**
 * Worker tile — Vercel/Linear-style left-aligned identity card. Avatar at the
 * top, then name / role / status stacked beneath, each at a distinct
 * typographic weight so the eye walks down the card cleanly. Queue badge
 * sits top-right; hover action cluster floats over the same corner.
 */
export const WorkerCard = ({
  hasRun,
  isPending = false,
  onAction,
  onClick,
  worker,
}: WorkerCardProps) => {
  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)

  const handleAction =
    (kind: WorkerCardActionKind): ((event: ReactMouseEvent<HTMLButtonElement>) => void) =>
    (event) => {
      event.stopPropagation()
      onAction?.(kind, worker)
    }

  return (
    <div
      className="worker-card-shell relative"
      data-status={status.kind}
      data-worker-name={worker.name}
    >
      <button
        type="button"
        onClick={() => onClick(worker)}
        aria-label={`Open ${worker.name}`}
        className="card card--interactive worker-card relative flex w-full flex-col gap-3 overflow-hidden p-4 text-left"
        data-testid={`worker-card-${worker.id}`}
        data-status={status.kind}
      >
        <div className="flex items-start gap-2">
          <CliAgentAvatar
            commandPresetId={worker.commandPresetId}
            workerRole={worker.role}
            size={40}
            statusRing={status.kind}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span
            className="truncate text-base font-medium leading-tight text-pri"
            title={worker.name}
          >
            {worker.name}
          </span>
          <span className="truncate text-xs leading-tight text-ter">{role.label}</span>
        </div>
        <span
          className={`pill ${pillToneByStatus[status.kind]} worker-card__status`}
          role="status"
          title={status.label}
        >
          <span className={status.dotClass} aria-hidden />
          {status.label}
        </span>
      </button>

      {onAction ? (
        <div className="worker-card__actions">
          {!hasRun ? (
            <CardActionBtn
              title="Start"
              onClick={handleAction('start')}
              disabled={isPending}
              variant="primary"
              testId={`worker-card-start-${worker.id}`}
              ariaLabel={`Start ${worker.name}`}
            >
              <Play size={12} aria-hidden />
            </CardActionBtn>
          ) : null}
          <CardActionBtn
            title="Rename"
            onClick={handleAction('rename')}
            disabled={isPending}
            testId={`worker-card-rename-${worker.id}`}
            ariaLabel={`Rename ${worker.name}`}
          >
            <Pencil size={12} aria-hidden />
          </CardActionBtn>
          <CardActionBtn
            title="Delete"
            onClick={handleAction('delete')}
            variant="danger"
            testId={`worker-card-delete-${worker.id}`}
            ariaLabel={`Delete ${worker.name}`}
          >
            <Trash2 size={12} aria-hidden />
          </CardActionBtn>
        </div>
      ) : null}
    </div>
  )
}

interface CardActionBtnProps {
  ariaLabel: string
  children: ReactNode
  disabled?: boolean
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  testId: string
  title: string
  variant?: 'default' | 'primary' | 'danger'
}

const CardActionBtn = ({
  ariaLabel,
  children,
  disabled,
  onClick,
  testId,
  title,
  variant = 'default',
}: CardActionBtnProps) => (
  <Tooltip label={title}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      data-variant={variant}
      className="worker-card__action"
    >
      {children}
    </button>
  </Tooltip>
)
