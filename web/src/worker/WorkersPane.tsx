import * as Accordion from '@radix-ui/react-accordion'
import { ChevronDown, UserPlus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { RenameWorkerDialog } from './RenameWorkerDialog.js'
import { WorkerCard, type WorkerCardActionKind } from './WorkerCard.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

type WorkersPaneProps = {
  onAddWorkerClick: () => void
  onDeleteWorker: (worker: TeamListItem) => void
  onOpenWorker: (worker: TeamListItem) => void
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onStartWorker: (worker: TeamListItem) => void
  onStopWorkerRun: (runId: string) => void
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
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
  onOpenWorker,
  onRenameWorker,
  onStartWorker,
  onStopWorkerRun,
  startingWorkerId,
  terminalRuns,
  workers,
}: WorkersPaneProps) => {
  const { t } = useI18n()
  const { sections, summary } = useMemo(() => summarizeWorkers(workers), [workers])
  const runIdsByAgentId = useMemo(
    () => new Map(terminalRuns.map((run) => [run.agent_id, run.run_id] as const)),
    [terminalRuns]
  )
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [renameTarget, setRenameTarget] = useState<TeamListItem | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)

  const handleAccordionChange = useCallback(() => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300)
  }, [])

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
      return
    }
    if (kind === 'stop') {
      const runId = runIdsByAgentId.get(worker.id)
      if (runId) onStopWorkerRun(runId)
      return
    }
    if (kind === 'rename') {
      setRenameTarget(worker)
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

  const submitRename = (worker: TeamListItem, newName: string) => {
    setRenameBusy(true)
    void onRenameWorker(worker, newName).finally(() => {
      setRenameBusy(false)
      setRenameTarget(null)
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <div
        className="flex shrink-0 flex-col gap-1 px-4 pt-3 pb-2.5"
        style={{
          boxShadow: 'inset 0 -1px 0 var(--border)',
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="text-lg font-semibold text-pri">{t('worker.teamMembers')}</span>
          <span className="mono inline-flex min-w-7 items-center justify-center rounded bg-3 px-2.5 py-1 text-base leading-none text-sec">
            {workers.length}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onAddWorkerClick}
            className="icon-btn icon-btn--primary"
            data-testid="add-worker-trigger"
          >
            <UserPlus size={14} aria-hidden /> {t('addWorker.create')}
          </button>
        </div>
        {workers.length > 0 ? (
          <div className="flex items-center gap-3 text-xs text-ter">
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--working" aria-hidden />
              <span className="text-sec">{summary.working}</span> {t('common.running')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--idle" aria-hidden />
              <span className="text-sec">{summary.idle}</span> {t('common.idle')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--stopped" aria-hidden />
              <span className="text-sec">{summary.stopped}</span> {t('common.stopped')}
            </span>
          </div>
        ) : null}
      </div>

      <div className="workers-pane-body scroll-y flex-1 px-2 py-2">
        {workers.length === 0 ? (
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
        ) : (
          <Accordion.Root
            type="multiple"
            defaultValue={['working', 'idle']}
            data-testid="worker-grid"
            onValueChange={handleAccordionChange}
          >
            {sections.map((section) => (
              <Accordion.Item key={section.kind} value={section.kind} className="accordion-section mb-1 last:mb-0">
                <Accordion.Header asChild>
                  <div className="accordion-trigger-wrap">
                    <Accordion.Trigger className="accordion-trigger" data-testid={`accordion-trigger-${section.kind}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`status-dot status-dot--${section.kind}`} aria-hidden />
                        <span className="text-xs font-medium uppercase tracking-wider text-ter">
                          {t(statusKey(section.kind))}
                        </span>
                        <span className="mono text-xs text-ter">{section.workers.length}</span>
                      </span>
                      <ChevronDown size={12} className="accordion-chevron" aria-hidden />
                    </Accordion.Trigger>
                  </div>
                </Accordion.Header>
                <Accordion.Content className="accordion-content">
                  <ul
                    aria-label={`${t(statusKey(section.kind))} team members`}
                    className="worker-card-grid"
                  >
                    {section.workers.map((worker) => (
                      <li key={worker.id}>
                        <WorkerCard
                          hasRun={runIdsByAgentId.has(worker.id)}
                          isPending={startingWorkerId === worker.id}
                          onAction={handleAction}
                          onClick={onOpenWorker}
                          worker={worker}
                        />
                      </li>
                    ))}
                  </ul>
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
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
      <RenameWorkerDialog
        worker={renameTarget}
        busy={renameBusy}
        onClose={() => setRenameTarget(null)}
        onSubmit={submitRename}
      />
    </div>
  )
}
