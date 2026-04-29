import { UserPlus } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { EmptyState } from '../ui/EmptyState.js'
import { WorkerCard } from './WorkerCard.js'

type WorkersPaneProps = {
  onAddWorkerClick: () => void
  onOpenWorker: (worker: TeamListItem) => void
  workers: TeamListItem[]
}

export const WorkersPane = ({ onAddWorkerClick, onOpenWorker, workers }: WorkersPaneProps) => (
  <div className="flex min-w-0 flex-1 flex-col">
    <div
      className="flex shrink-0 items-center gap-3 border-b px-4 py-2"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
    >
      <span className="font-medium text-pri">Team Members</span>
      <span className="rounded bg-3 px-1.5 py-0.5 mono text-[10px] text-sec">{workers.length}</span>
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

    <div className="flex-1 scroll-y p-4">
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
        <ul
          aria-label="Team members"
          className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          data-testid="worker-grid"
        >
          {workers.map((worker) => (
            <li key={worker.id}>
              <WorkerCard worker={worker} onClick={onOpenWorker} />
            </li>
          ))}
        </ul>
      )}
    </div>
  </div>
)
