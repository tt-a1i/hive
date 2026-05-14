import { UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { findRunByAgentId } from '../terminal/useTerminalRuns.js'
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
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
}

interface WorkerSection {
  kind: WorkerStatusKind
  label: string
  workers: TeamListItem[]
}

const SECTION_ORDER: WorkerStatusKind[] = ['working', 'idle', 'stopped']
const SECTION_LABEL: Record<WorkerStatusKind, string> = {
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
}

const groupByStatus = (workers: TeamListItem[]): WorkerSection[] => {
  const buckets: Record<WorkerStatusKind, TeamListItem[]> = {
    working: [],
    idle: [],
    stopped: [],
  }
  for (const worker of workers) {
    buckets[presentWorkerStatus(worker).kind].push(worker)
  }
  return SECTION_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
    kind,
    label: SECTION_LABEL[kind],
    workers: buckets[kind],
  }))
}

export const WorkersPane = ({
  onAddWorkerClick,
  onDeleteWorker,
  onOpenWorker,
  onRenameWorker,
  onStartWorker,
  startingWorkerId,
  terminalRuns,
  workers,
}: WorkersPaneProps) => {
  const sections = useMemo(() => groupByStatus(workers), [workers])
  const summary = useMemo(() => {
    const buckets = { working: 0, idle: 0, stopped: 0 }
    for (const worker of workers) buckets[presentWorkerStatus(worker).kind]++
    return buckets
  }, [workers])
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [renameTarget, setRenameTarget] = useState<TeamListItem | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)

  const runIdFor = (worker: TeamListItem): string | null =>
    findRunByAgentId(terminalRuns, worker.id)?.run_id ?? null

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
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
        <div className="flex items-center gap-2">
          <span className="font-medium text-pri">Team Members</span>
          <span className="mono rounded bg-3 px-1.5 py-0.5 text-[10px] text-sec">
            {workers.length}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onAddWorkerClick}
            className="icon-btn icon-btn--primary"
            data-testid="add-worker-trigger"
          >
            <UserPlus size={14} aria-hidden /> Add Member
          </button>
        </div>
        {workers.length > 0 ? (
          <div className="flex items-center gap-3 text-[11px] text-ter">
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--working" aria-hidden />
              <span className="text-sec">{summary.working}</span> working
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--idle" aria-hidden />
              <span className="text-sec">{summary.idle}</span> idle
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--stopped" aria-hidden />
              <span className="text-sec">{summary.stopped}</span> stopped
            </span>
          </div>
        ) : null}
      </div>

      <div className="workers-pane-body scroll-y flex-1 px-2 py-2">
        {workers.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={28} />}
            title="No team members yet"
            description="Team members are CLI agents (Claude, Codex, OpenCode…) the Orchestrator dispatches work to via team send."
            action={
              <button
                type="button"
                onClick={onAddWorkerClick}
                className="icon-btn icon-btn--primary"
                data-testid="add-worker-empty"
              >
                <UserPlus size={14} aria-hidden /> Add your first member
              </button>
            }
          />
        ) : (
          <div data-testid="worker-grid">
            {sections.map((section) => (
              <section key={section.kind} className="mb-3 last:mb-0">
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-ter">
                  {section.label}
                  <span className="mono ml-1.5 text-ter">{section.workers.length}</span>
                </div>
                <ul aria-label={`${section.label} team members`} className="worker-card-grid">
                  {section.workers.map((worker) => (
                    <li key={worker.id}>
                      <WorkerCard
                        hasRun={!!runIdFor(worker)}
                        isPending={startingWorkerId === worker.id}
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
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : ''}
        description={
          pendingDelete
            ? `This stops ${pendingDelete.name}'s terminal and removes it from the workspace. All queued dispatches are dropped.`
            : ''
        }
        confirmLabel="Delete member"
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
