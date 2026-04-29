import type { WorkspaceSummary } from '../../src/shared/types.js'
import type { WorkspaceStats } from './useWorkspaceStats.js'

type WorkspaceSubHeaderProps = {
  stats: WorkspaceStats
  workspace: WorkspaceSummary
}

const branchLabel = (workspace: WorkspaceSummary): string =>
  workspace.path.split('/').pop() ?? 'main'

const StatChip = ({
  count,
  kind,
  label,
}: {
  count: number
  kind: 'working' | 'idle' | 'stopped'
  label: string
}) => (
  <span className="inline-flex items-center gap-1.5 text-[11px] text-ter" data-stat={kind}>
    <span className={`status-dot status-dot--${kind}`} aria-hidden />
    <span>
      <span className="mono text-sec">{count}</span> {label}
    </span>
  </span>
)

export const WorkspaceSubHeader = ({ stats, workspace }: WorkspaceSubHeaderProps) => (
  <div
    className="flex h-9 shrink-0 items-center gap-3 border-b px-4 text-xs text-sec"
    style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
    data-testid="workspace-sub-header"
  >
    <span className="font-medium text-pri">{workspace.name}</span>
    <span className="text-ter" aria-hidden>
      ·
    </span>
    <span className="mono truncate text-ter">{workspace.path}</span>
    <span className="text-ter" aria-hidden>
      ·
    </span>
    <span className="mono text-ter">{branchLabel(workspace)}</span>
    <div className="flex-1" />
    <div
      className="flex items-center gap-3"
      role="status"
      aria-label="Runtime status"
      title="working + idle + stopped = total. queued is an independent axis (pending dispatches)."
    >
      <StatChip count={stats.working} kind="working" label="working" />
      <StatChip count={stats.idle} kind="idle" label="idle" />
      <StatChip count={stats.stopped} kind="stopped" label="stopped" />
      <span className="mono text-[10px] text-ter">of {stats.total}</span>
      {stats.queued > 0 ? (
        <>
          <span className="text-ter" aria-hidden>
            ·
          </span>
          <span
            className="inline-flex items-center gap-1.5 text-[11px]"
            data-stat="queued"
            title="Workers with pending dispatches (independent of PTY state)"
          >
            <span className="status-dot status-dot--queued" aria-hidden />
            <span className="text-status-orange">
              <span className="mono">{stats.queued}</span> queued
            </span>
          </span>
        </>
      ) : null}
    </div>
  </div>
)
