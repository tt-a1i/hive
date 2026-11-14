import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowLeftRight,
  ImageIcon,
  MoreVertical,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { RenameInput } from './RenameInput.js'
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

export type WorkerCardActionKind =
  | 'start'
  | 'stop'
  | 'restart'
  | 'rename'
  | 'avatar'
  | 'delete'
  | 'switch-cli'

type WorkerCardProps = {
  hasRun: boolean
  canSwitchCli?: boolean
  isPending?: boolean
  isEditing?: boolean
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onStartEditing?: () => void
  onCancelEditing?: () => void
  onAction?: (kind: WorkerCardActionKind, worker: TeamListItem) => void
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

/**
 * Worker tile — compact left-aligned identity card. Avatar, name, and role form
 * one horizontal identity row; live state and hover actions share a quiet
 * footer so narrow panes do not turn a small roster into oversized tiles.
 */
export const WorkerCard = ({
  hasRun,
  canSwitchCli = false,
  isPending = false,
  isEditing = false,
  onRenameWorker,
  onStartEditing,
  onCancelEditing,
  onAction,
  onClick,
  worker,
}: WorkerCardProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const status = presentWorkerStatus(worker)

  const [saving, setSaving] = useState(false)

  const handleAction =
    (kind: WorkerCardActionKind): ((event: ReactMouseEvent<HTMLButtonElement>) => void) =>
    (event) => {
      event.stopPropagation()
      if (kind === 'rename') {
        onStartEditing?.()
        return
      }
      onAction?.(kind, worker)
    }

  // Visually mark workflow-spawned ephemeral workers — they are temporary
  // members of the team for the duration of one dispatch, not part of the
  // user's persistent roster (M10).
  const isWorkflowSpawned = worker.ephemeral === true && worker.spawnedBy === 'workflow'
  const isOrchestratorSpawned = worker.ephemeral === true && worker.spawnedBy === 'orchestrator'
  const ephemeralTone = isWorkflowSpawned
    ? 'workflow'
    : isOrchestratorSpawned
      ? 'orchestrator'
      : null

  // Phones keep the dedicated list row + kebab action sheet; showing the
  // desktop card's full action cluster would consume half of a narrow row.
  if (isMobile) {
    return (
      <MobileWorkerRow
        ephemeralTone={ephemeralTone}
        hasRun={hasRun}
        isPending={isPending}
        onAction={onAction}
        onClick={onClick}
        status={status}
        worker={worker}
        isEditing={isEditing}
        onRenameWorker={onRenameWorker}
        onCancelEditing={onCancelEditing}
      />
    )
  }

  const Container = (isEditing ? 'div' : 'button') as 'div' | 'button'

  return (
    <div
      className="worker-card-shell relative"
      data-status={status.kind}
      data-worker-name={worker.name}
      data-ephemeral={worker.ephemeral === true ? 'true' : undefined}
      data-spawned-by={worker.spawnedBy ?? undefined}
      // On a phone there is no hover, so the action cluster (hidden behind
      // :hover on desktop) must be forced visible + tappable. This flag drives
      // the mobile-only CSS in globals.css.
      data-mobile={isMobile ? 'true' : undefined}
    >
      <Container
        type={isEditing ? undefined : 'button'}
        onClick={isEditing ? undefined : () => onClick(worker)}
        aria-label={isEditing ? undefined : t('worker.open', { name: worker.name })}
        className={`card worker-card relative flex w-full flex-col overflow-hidden text-left ${
          isEditing ? '' : 'card--interactive'
        }${onAction ? ' worker-card--with-actions' : ''}`}
        data-testid={`worker-card-${worker.id}`}
        data-status={status.kind}
        style={
          ephemeralTone
            ? {
                borderStyle: 'dashed',
                borderColor:
                  ephemeralTone === 'workflow' ? 'var(--accent)' : 'var(--border-bright)',
              }
            : undefined
        }
      >
        <div className="worker-card__identity-row">
          <CliAgentAvatar
            commandPresetId={worker.commandPresetId}
            customAvatar={worker.avatar}
            workerRole={worker.role}
            size={40}
            statusRing={status.kind}
          />
          <div className="worker-card__identity">
            {isEditing ? (
              <RenameInput
                initialValue={worker.name}
                saving={saving}
                setSaving={setSaving}
                onSave={(newName) => onRenameWorker(worker, newName)}
                onCancel={() => onCancelEditing?.()}
                className="worker-card-name-input"
              />
            ) : (
              <span className="worker-card__name" title={worker.name}>
                {worker.name}
              </span>
            )}
            <span className="worker-card__role-tag">{t(roleKey(worker.role))}</span>
          </div>
          {ephemeralTone ? (
            <span
              className="worker-card__ephemeral"
              data-testid="worker-card-ephemeral-badge"
              title={
                ephemeralTone === 'workflow'
                  ? 'Spawned by a workflow run — auto-dismissed when its dispatch reports back.'
                  : 'Spawned by the orchestrator via `team spawn` — auto-dismissed when the orchestrator exits.'
              }
            >
              {ephemeralTone === 'workflow' ? 'workflow' : 'temp'}
            </span>
          ) : null}
        </div>
        <div className="worker-card__footer">
          <span
            className={`pill ${pillToneByStatus[status.kind]} worker-card__status`}
            role="status"
            title={
              status.kind === 'working' ? t('worker.workingLegend') : t(statusKey(status.kind))
            }
          >
            <span className={status.dotClass} aria-hidden />
            {t(statusKey(status.kind))}
          </span>
        </div>
      </Container>

      {onAction ? (
        <div className="worker-card__actions">
          {/* Stop/Restart are a MOBILE-ONLY addition. On a phone the card is the
              only place these live (no hover-modal path), so the touch cluster
              carries them. Desktop keeps its `main` rendering byte-for-byte:
              Start-when-stopped, else nothing — never Stop/Restart on the card. */}
          {hasRun ? (
            isMobile ? (
              <>
                <CardActionBtn
                  title={t('common.stop')}
                  onClick={handleAction('stop')}
                  variant="danger"
                  testId={`worker-card-stop-${worker.id}`}
                  ariaLabel={t('worker.stopAria', { name: worker.name })}
                >
                  <Square size={12} aria-hidden />
                </CardActionBtn>
                <CardActionBtn
                  title={t('common.restart')}
                  onClick={handleAction('restart')}
                  testId={`worker-card-restart-${worker.id}`}
                  ariaLabel={t('worker.restartAria', { name: worker.name })}
                >
                  <RotateCcw size={12} aria-hidden />
                </CardActionBtn>
              </>
            ) : null
          ) : (
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
          )}
          {canSwitchCli && worker.spawnedBy !== 'workflow' && (
            <CardActionBtn
              title={t('switchCli.title')}
              onClick={handleAction('switch-cli')}
              disabled={isPending}
              testId={`worker-card-switch-cli-${worker.id}`}
              ariaLabel={t('switchCli.workerAria', { name: worker.name })}
            >
              <ArrowLeftRight size={12} aria-hidden />
            </CardActionBtn>
          )}
          <CardActionBtn
            title={t('worker.rename')}
            onClick={handleAction('rename')}
            disabled={isPending || status.kind === 'working'}
            testId={`worker-card-rename-${worker.id}`}
            ariaLabel={t('worker.renameAria', { name: worker.name })}
          >
            <Pencil size={12} aria-hidden />
          </CardActionBtn>
          <CardActionBtn
            title={t('worker.avatarChange')}
            onClick={handleAction('avatar')}
            disabled={isPending}
            testId={`worker-card-avatar-${worker.id}`}
            ariaLabel={t('worker.avatarChangeAria', { name: worker.name })}
          >
            <ImageIcon size={12} aria-hidden />
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

// ── Mobile list row + kebab action sheet ──────────────────────────────────

const MobileWorkerRow = ({
  ephemeralTone,
  hasRun,
  isPending,
  onAction,
  onClick,
  status,
  worker,
  isEditing = false,
  onRenameWorker,
  onCancelEditing,
}: {
  ephemeralTone: 'workflow' | 'orchestrator' | null
  hasRun: boolean
  isPending: boolean
  onAction: ((kind: WorkerCardActionKind, worker: TeamListItem) => void) | undefined
  onClick: (worker: TeamListItem) => void
  status: ReturnType<typeof presentWorkerStatus>
  worker: TeamListItem
  isEditing?: boolean
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onCancelEditing?: (() => void) | undefined
}) => {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)

  const [saving, setSaving] = useState(false)
  const isTransitioningToEdit = useRef(false)

  const act = (kind: WorkerCardActionKind) => {
    if (kind === 'rename') {
      isTransitioningToEdit.current = true
    }
    setMenuOpen(false)
    onAction?.(kind, worker)
  }

  const subline = t(roleKey(worker.role))
  const Container = (isEditing ? 'div' : 'button') as 'div' | 'button'

  return (
    <div
      className="worker-card-shell relative"
      data-status={status.kind}
      data-worker-name={worker.name}
      data-ephemeral={worker.ephemeral === true ? 'true' : undefined}
      data-spawned-by={worker.spawnedBy ?? undefined}
      data-mobile="true"
    >
      <Container
        type={isEditing ? undefined : 'button'}
        onClick={isEditing ? undefined : () => onClick(worker)}
        aria-label={isEditing ? undefined : t('worker.open', { name: worker.name })}
        className={`card worker-card flex w-full items-center gap-3 p-3 pr-12 text-left ${
          isEditing ? '' : 'card--interactive'
        }`}
        data-testid={`worker-card-${worker.id}`}
        data-status={status.kind}
        style={
          ephemeralTone
            ? {
                borderStyle: 'dashed',
                borderColor:
                  ephemeralTone === 'workflow' ? 'var(--accent)' : 'var(--border-bright)',
              }
            : undefined
        }
      >
        <CliAgentAvatar
          commandPresetId={worker.commandPresetId}
          customAvatar={worker.avatar}
          workerRole={worker.role}
          size={40}
          statusRing={status.kind}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {isEditing ? (
              <RenameInput
                initialValue={worker.name}
                saving={saving}
                setSaving={setSaving}
                onSave={(newName) => onRenameWorker(worker, newName)}
                onCancel={() => onCancelEditing?.()}
                className="worker-card-name-input flex-1"
              />
            ) : (
              <span className="truncate text-sm font-medium text-pri">{worker.name}</span>
            )}
            {ephemeralTone ? (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  background:
                    ephemeralTone === 'workflow'
                      ? 'color-mix(in oklab, var(--accent) 18%, transparent)'
                      : 'color-mix(in oklab, var(--text-secondary) 14%, transparent)',
                  color: ephemeralTone === 'workflow' ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                data-testid="worker-card-ephemeral-badge"
              >
                {ephemeralTone === 'workflow' ? 'workflow' : 'temp'}
              </span>
            ) : null}
          </span>
          <span className="truncate text-xs text-ter">{subline}</span>
        </span>
        <span
          className={`pill ${pillToneByStatus[status.kind]} worker-card__status shrink-0`}
          role="status"
        >
          <span className={status.dotClass} aria-hidden />
          {t(statusKey(status.kind))}
        </span>
      </Container>

      {onAction ? (
        <>
          <button
            type="button"
            aria-label={t('worker.actionsAria', { name: worker.name })}
            data-testid={`worker-card-menu-${worker.id}`}
            onClick={() => setMenuOpen(true)}
            className="absolute top-1/2 right-1 z-[2] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-ter"
          >
            <MoreVertical size={18} aria-hidden />
          </button>
          <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
              <div className="pointer-events-none fixed inset-0 z-50 grid items-end">
                <Dialog.Content
                  onCloseAutoFocus={(e) => {
                    if (isTransitioningToEdit.current) {
                      e.preventDefault()
                      isTransitioningToEdit.current = false
                    }
                  }}
                  data-testid={`worker-action-sheet-${worker.id}`}
                  className="dialog-slide-up elev-2 pointer-events-auto flex w-full flex-col overflow-hidden rounded-t-xl border-t pb-[max(8px,env(safe-area-inset-bottom))]"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
                >
                  <Dialog.Title
                    className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold text-pri"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span className="truncate">{worker.name}</span>
                    <span className="shrink-0 text-xs font-normal text-ter">
                      {t(statusKey(status.kind))}
                    </span>
                  </Dialog.Title>
                  <Dialog.Description className="sr-only">
                    {t('worker.actionsAria', { name: worker.name })}
                  </Dialog.Description>
                  {hasRun ? (
                    <>
                      <SheetAction
                        icon={<Square size={16} aria-hidden />}
                        label={t('common.stop')}
                        onSelect={() => act('stop')}
                        testId={`worker-card-stop-${worker.id}`}
                        danger
                      />
                      <SheetAction
                        icon={<RotateCcw size={16} aria-hidden />}
                        label={t('common.restart')}
                        onSelect={() => act('restart')}
                        testId={`worker-card-restart-${worker.id}`}
                      />
                    </>
                  ) : (
                    <SheetAction
                      disabled={isPending}
                      icon={<Play size={16} aria-hidden />}
                      label={t('common.start')}
                      onSelect={() => act('start')}
                      testId={`worker-card-start-${worker.id}`}
                    />
                  )}
                  <SheetAction
                    disabled={isPending || status.kind === 'working'}
                    icon={<Pencil size={16} aria-hidden />}
                    label={t('worker.rename')}
                    onSelect={() => act('rename')}
                    testId={`worker-card-rename-${worker.id}`}
                  />
                  <SheetAction
                    disabled={isPending}
                    icon={<ImageIcon size={16} aria-hidden />}
                    label={t('worker.avatarChange')}
                    onSelect={() => act('avatar')}
                    testId={`worker-card-avatar-${worker.id}`}
                  />
                  <SheetAction
                    icon={<Trash2 size={16} aria-hidden />}
                    label={t('common.delete')}
                    onSelect={() => act('delete')}
                    testId={`worker-card-delete-${worker.id}`}
                    danger
                  />
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      ) : null}
    </div>
  )
}

const SheetAction = ({
  danger = false,
  disabled = false,
  icon,
  label,
  onSelect,
  testId,
}: {
  danger?: boolean
  disabled?: boolean
  icon: ReactNode
  label: string
  onSelect: () => void
  testId: string
}) => (
  <button
    type="button"
    disabled={disabled}
    data-testid={testId}
    onClick={onSelect}
    className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm disabled:opacity-50"
    style={{ color: danger ? 'var(--status-red)' : 'var(--text-primary)' }}
  >
    {icon}
    {label}
  </button>
)
