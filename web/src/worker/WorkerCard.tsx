import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MessageCircle, MoreHorizontal, Pencil, Play, Square, Trash2 } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { DiscussionGroup } from '../discussion/types.js'
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
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

export type WorkerCardActionKind = 'start' | 'stop' | 'rename' | 'delete'

type WorkerCardProps = {
  activeDiscussion?: DiscussionGroup | null
  hasRun: boolean
  isPending?: boolean
  onAction?: (kind: WorkerCardActionKind, worker: TeamListItem) => void
  onDiscussionClick?: (group: DiscussionGroup) => void
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
  activeDiscussion,
  hasRun,
  isPending = false,
  onAction,
  onDiscussionClick,
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
        className="card card--interactive worker-card relative flex w-full items-center gap-2 overflow-hidden px-2.5 py-2 text-left"
        data-testid={`worker-card-${worker.id}`}
        data-status={status.kind}
      >
        <CliAgentAvatar
          commandPresetId={worker.commandPresetId}
          workerRole={worker.role}
          size={24}
          statusRing={status.kind}
        />
        <span className="min-w-0 flex-1 truncate text-sm leading-tight" title={worker.name}>
          <span className="font-medium text-pri">{worker.name}</span>
          <span className="text-ter"> · {worker.role === 'custom' && worker.roleTemplateName ? worker.roleTemplateName : t(roleKey(worker.role))}</span>
        </span>
        <span
          className={`pill ${pillToneByStatus[status.kind]} worker-card__status`}
          role="status"
          title={t(statusKey(status.kind))}
        >
          <span className={status.dotClass} aria-hidden />
          {t(statusKey(status.kind))}
        </span>
        {activeDiscussion ? (
          <button
            type="button"
            className="pill pill--blue worker-card__discussion-badge"
            onClick={(e) => {
              e.stopPropagation()
              onDiscussionClick?.(activeDiscussion)
            }}
            title={activeDiscussion.topic}
          >
            <MessageCircle size={10} aria-hidden />
            {t('discussion.badge', {
              round: activeDiscussion.currentRound,
              total: activeDiscussion.maxRounds,
            })}
          </button>
        ) : null}
      </button>

      {onAction ? (
        <div className="worker-card__actions">
          {status.kind === 'working' && hasRun ? (
            <CardActionBtn
              title={t('common.stop')}
              onClick={handleAction('stop')}
              disabled={isPending}
              variant="danger"
              testId={`worker-card-stop-${worker.id}`}
              ariaLabel={t('worker.stopAria', { name: worker.name })}
            >
              <Square size={12} aria-hidden />
            </CardActionBtn>
          ) : null}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="worker-card__action"
                data-testid={`worker-card-more-${worker.id}`}
                aria-label={t('common.moreActions')}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={14} aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown-menu"
                sideOffset={4}
                align="end"
                onClick={(e) => e.stopPropagation()}
              >
                {!hasRun ? (
                  <DropdownMenu.Item
                    className="dropdown-menu__item"
                    data-testid={`worker-card-start-${worker.id}`}
                    disabled={isPending}
                    onSelect={() => onAction('start', worker)}
                  >
                    <Play size={12} aria-hidden />
                    {t('common.start')}
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item
                  className="dropdown-menu__item"
                  data-testid={`worker-card-rename-${worker.id}`}
                  disabled={isPending}
                  onSelect={() => onAction('rename', worker)}
                >
                  <Pencil size={12} aria-hidden />
                  {t('worker.rename')}
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="dropdown-menu__separator" />
                <DropdownMenu.Item
                  className="dropdown-menu__item dropdown-menu__item--danger"
                  data-testid={`worker-card-delete-${worker.id}`}
                  onSelect={() => onAction('delete', worker)}
                >
                  <Trash2 size={12} aria-hidden />
                  {t('common.delete')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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
