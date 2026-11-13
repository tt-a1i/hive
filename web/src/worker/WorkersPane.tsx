import { Terminal, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { ScenarioTeamCards } from './ScenarioTeamCards.js'
import { WorkerAvatarDialog } from './WorkerAvatarDialog.js'
import { WorkerCard, type WorkerCardActionKind } from './WorkerCard.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

type WorkersPaneProps = {
  onAddWorkerClick: () => void
  onDeleteWorker: (worker: TeamListItem) => void
  onOpenShellTerminal: () => void
  onOpenWorker: (worker: TeamListItem) => void
  onSwitchCli?: (worker: TeamListItem) => void
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onUpdateWorkerAvatar: (
    workerId: string,
    avatar: string | null
  ) => Promise<{ error: string | null }>
  /** Stop a running worker. Takes the RUN id (stop targets the PTY run, not the
   *  agent record). Optional so callers that don't surface stop stay valid. */
  onStopWorker?: (runId: string) => void
  /** Restart a running worker. Takes the worker id AND its current run id so the
   *  action can stop the old PTY then start a fresh one. */
  onRestartWorker?: (workerId: string, runId: string) => void
  onStartWorker: (worker: TeamListItem) => void
  shellTerminalAvailable?: boolean
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  /** Enables the scenario-team cards in the empty state. Omitted in contexts
   *  without a real workspace (e.g. demo fixtures). */
  workspaceId?: string
}

const SECTION_ORDER: WorkerStatusKind[] = ['working', 'idle', 'stopped']
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

const summarizeWorkers = (workers: TeamListItem[]) => {
  const buckets: Record<WorkerStatusKind, TeamListItem[]> = {
    idle: [],
    working: [],
    stopped: [],
  }
  for (const worker of workers) buckets[presentWorkerStatus(worker).kind].push(worker)
  return {
    sections: SECTION_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
      kind,
      workers: buckets[kind],
    })),
    summary: {
      idle: buckets.idle.length,
      stopped: buckets.stopped.length,
      working: buckets.working.length,
    },
  }
}

export const WorkersPane = ({
  onAddWorkerClick,
  onDeleteWorker,
  onOpenShellTerminal,
  onOpenWorker,
  onSwitchCli,
  onRenameWorker,
  onUpdateWorkerAvatar,
  onStopWorker,
  onRestartWorker,
  onStartWorker,
  shellTerminalAvailable = true,
  startingWorkerId,
  terminalRuns,
  workers,
  workspaceId,
}: WorkersPaneProps) => {
  const { t } = useI18n()
  const { sections, summary } = useMemo(() => summarizeWorkers(workers), [workers])
  const runIdsByAgentId = useMemo(
    () => new Map(terminalRuns.map((run) => [run.agent_id, run.run_id] as const)),
    [terminalRuns]
  )
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [avatarWorker, setAvatarWorker] = useState<TeamListItem | null>(null)
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null)

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
      return
    }
    if (kind === 'stop') {
      const runId = runIdsByAgentId.get(worker.id)
      if (runId) onStopWorker?.(runId)
      return
    }
    if (kind === 'restart') {
      const runId = runIdsByAgentId.get(worker.id)
      if (runId) onRestartWorker?.(worker.id, runId)
      return
    }
    if (kind === 'switch-cli') {
      onSwitchCli?.(worker)
      return
    }
    if (kind === 'rename') {
      setEditingWorkerId(worker.id)
      return
    }
    if (kind === 'avatar') {
      setAvatarWorker(worker)
      return
    }
    if (kind === 'delete') {
      setPendingDelete(worker)
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    onDeleteWorker(pendingDelete)
    setPendingDelete(null)
  }

  return (
    <div className="workers-pane flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workers-pane">
      <div className="workers-pane__header">
        <div className="workers-pane__title-row">
          <span className="workers-pane__title">{t('worker.teamMembers')}</span>
          <span className="workers-pane__count">{workers.length}</span>
          <div className="workers-pane__actions">
            {shellTerminalAvailable ? (
              <button
                type="button"
                onClick={onOpenShellTerminal}
                className="icon-btn icon-btn--tertiary"
                aria-label={t('shellTerminal.openAria')}
                data-testid="open-workspace-shell"
              >
                <Terminal size={14} aria-hidden /> {t('shellTerminal.open')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onAddWorkerClick}
              className="icon-btn icon-btn--primary"
              data-testid="add-worker-trigger"
            >
              <UserPlus size={14} aria-hidden /> {t('addWorker.create')}
            </button>
          </div>
        </div>
        {workers.length > 0 ? (
          <div className="workers-pane__summary">
            <span className="workers-pane__summary-item">
              <span className="status-dot status-dot--working" aria-hidden />
              <span className="text-sec">{summary.working}</span> {t('common.running')}
            </span>
            <span className="workers-pane__summary-item">
              <span className="status-dot status-dot--idle" aria-hidden />
              <span className="text-sec">{summary.idle}</span> {t('common.idle')}
            </span>
            <span className="workers-pane__summary-item">
              <span className="status-dot status-dot--stopped" aria-hidden />
              <span className="text-sec">{summary.stopped}</span> {t('common.stopped')}
            </span>
          </div>
        ) : null}
      </div>

      <div className="workers-pane-body workers-pane__body scroll-y min-h-0 min-w-0 flex-1">
        {workers.length === 0 ? (
          <>
            <EmptyState
              icon={<UserPlus size={28} />}
              title={t('worker.emptyTitle')}
              description={t('worker.emptyDesc')}
              action={
                <button
                  type="button"
                  onClick={onAddWorkerClick}
                  className="icon-btn icon-btn--primary"
                  data-testid="add-worker-empty"
                >
                  <UserPlus size={14} aria-hidden /> {t('worker.emptyAdd')}
                </button>
              }
            />
            {workspaceId ? <ScenarioTeamCards workspaceId={workspaceId} /> : null}
          </>
        ) : (
          <div data-testid="worker-grid">
            {sections.map((section) => (
              <section key={section.kind} className="worker-section">
                <div className="worker-section__heading">
                  <span>{t(statusKey(section.kind))}</span>
                  <span className="worker-section__count">{section.workers.length}</span>
                </div>
                <ul
                  aria-label={`${t(statusKey(section.kind))} team members`}
                  className="worker-card-grid"
                >
                  {section.workers.map((worker) => (
                    <li key={worker.id}>
                      <WorkerCard
                        hasRun={runIdsByAgentId.has(worker.id)}
                        canSwitchCli={Boolean(onSwitchCli)}
                        isPending={
                          startingWorkerId === worker.id ||
                          (worker.status === 'working' && !runIdsByAgentId.has(worker.id)) ||
                          // Live run whose startup injection has not finished:
                          // the runtime has not stamped startup_ready_at yet.
                          (runIdsByAgentId.has(worker.id) &&
                            worker.status !== 'stopped' &&
                            worker.startupReadyAt == null)
                        }
                        isEditing={editingWorkerId === worker.id}
                        onRenameWorker={async (w, newName) => {
                          const nameExists = workers.some(
                            (item) =>
                              item.id !== w.id && item.name.toLowerCase() === newName.toLowerCase()
                          )
                          if (nameExists) {
                            return { error: t('addWorker.agentExists') }
                          }
                          return onRenameWorker(w, newName)
                        }}
                        onStartEditing={() => setEditingWorkerId(worker.id)}
                        onCancelEditing={() => setEditingWorkerId(null)}
                        onAction={handleAction}
                        onClick={onOpenWorker}
                        worker={worker}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <Confirm
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={pendingDelete ? t('worker.deleteConfirm', { name: pendingDelete.name }) : ''}
        description={
          pendingDelete ? t('worker.deleteDescription', { name: pendingDelete.name }) : ''
        }
        confirmLabel={t('worker.deleteMember')}
        confirmKind="danger"
        onConfirm={confirmDelete}
      />
      {avatarWorker ? (
        <WorkerAvatarDialog
          worker={avatarWorker}
          onClose={() => setAvatarWorker(null)}
          onSave={(avatar) => onUpdateWorkerAvatar(avatarWorker.id, avatar)}
        />
      ) : null}
    </div>
  )
}
