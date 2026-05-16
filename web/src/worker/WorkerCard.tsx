import { Pencil, Play, Trash2 } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

const pillToneByStatus: Record<WorkerStatusKind, string> = {
  working: 'pill--green',
  idle: 'pill--ghost',
  stopped: 'pill--red',
}
const roleKey = (role: TeamListItem['role']) =>
  `role.${role}` as 'role.coder' | 'role.custom' | 'role.reviewer' | 'role.tester'
const statusKey = (status: WorkerStatusKind) =>
  `common.${status}` as 'common.idle' | 'common.stopped' | 'common.working'

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
  const { t } = useI18n()
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
        aria-label={t('worker.open', { name: worker.name })}
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
          <span className="truncate text-xs leading-tight text-ter">{t(roleKey(worker.role))}</span>
        </div>
        <span
          className={`pill ${pillToneByStatus[status.kind]} worker-card__status`}
          role="status"
          title={t(statusKey(status.kind))}
        >
          <span className={status.dotClass} aria-hidden />
          {t(statusKey(status.kind))}
        </span>
      </button>

      {onAction ? (
        <div className="worker-card__actions">
          {!hasRun ? (
            <CardActionBtn
              title={t('common.start')}
              onClick={handleAction('start')}
              disabled={isPending}
              variant="primary"
              testId={`worker-card-start-${worker.id}`}
              ariaLabel={t('worker.startAria', { name: worker.name })}
            >
              <Play size={12} aria-hidden />
            </CardActionBtn>
          ) : null}
          <CardActionBtn
            title={t('worker.rename')}
            onClick={handleAction('rename')}
            disabled={isPending}
            testId={`worker-card-rename-${worker.id}`}
            ariaLabel={t('worker.renameAria', { name: worker.name })}
          >
            <Pencil size={12} aria-hidden />
          </CardActionBtn>
          <CardActionBtn
            title={t('common.delete')}
            onClick={handleAction('delete')}
            variant="danger"
            testId={`worker-card-delete-${worker.id}`}
            ariaLabel={t('worker.deleteAria', { name: worker.name })}
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
