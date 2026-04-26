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
      <span className="text-ter text-xs">{workers.length}</span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onAddWorkerClick}
        className="flex items-center gap-1 rounded px-2.5 py-1 text-xs text-white hover:opacity-90"
        style={{ background: 'var(--accent)' }}
      >
        <span className="text-sm leading-none" aria-hidden>
          +
        </span>
        New Member
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
            className="card flex min-h-[140px] w-full flex-col items-center justify-center p-4 text-ter hover:text-sec"
            style={{ borderStyle: 'dashed' }}
          >
            <span className="mb-1 text-2xl leading-none" aria-hidden>
              +
            </span>
            <span className="text-xs">New Member</span>
            <span className="mt-1 text-[10px] text-ter">
              Coder · Reviewer · Tester · Architect · Custom
            </span>
          </button>
        </li>
        {workers.map((worker) => (
          <li key={worker.id}>
            <WorkerCard worker={worker} onClick={onOpenWorker} />
          </li>
        ))}
      </ul>
    </div>
  </div>
)
