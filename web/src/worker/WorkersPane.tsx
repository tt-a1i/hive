import { UserPlus } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
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
      <ul
        aria-label="Team members"
        className="grid grid-cols-1 gap-3 lg:grid-cols-2"
        data-testid="worker-grid"
      >
        <li>
          <button
            type="button"
            onClick={onAddWorkerClick}
            className="card flex min-h-[112px] w-full flex-col items-center justify-center gap-2 p-4 text-ter hover:text-sec"
            style={{ borderStyle: 'dashed' }}
          >
            <UserPlus size={20} aria-hidden />
            <span className="text-xs">Add Member</span>
            <span className="text-[10px] text-ter">Coder · Reviewer · Tester · Custom</span>
          </button>
        </li>
        {workers.map((worker) => (
          <li key={worker.id}>
            <WorkerCard worker={worker} onClick={onOpenWorker} />
          </li>
        ))}
      </ul>
      {workers.length === 0 ? (
        <p className="mt-6 max-w-[420px] text-[11px] text-ter">
          Team members are CLI agents (Claude, Codex, OpenCode, …) running as PTYs in this
          workspace. The Orchestrator dispatches work to them via{' '}
          <span className="mono">team send</span> and they reply via{' '}
          <span className="mono">team report</span>.
        </p>
      ) : null}
    </div>
  </div>
)
