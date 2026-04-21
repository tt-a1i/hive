import type { WorkspaceSummary } from '../../src/shared/types.js'

type WorkspaceSubHeaderProps = {
  activeCount: number
  agentCount: number
  workspace: WorkspaceSummary
}

const branchLabel = (workspace: WorkspaceSummary): string =>
  workspace.path.split('/').pop() ?? 'main'

export const WorkspaceSubHeader = ({
  activeCount,
  agentCount,
  workspace,
}: WorkspaceSubHeaderProps) => (
  <div
    className="flex h-8 shrink-0 items-center border-b px-4 text-xs text-sec"
    style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
    data-testid="workspace-sub-header"
  >
    <span className="font-medium text-pri">{workspace.name}</span>
    <span className="mx-2 text-ter" aria-hidden>
      ·
    </span>
    <span className="mono truncate text-ter">{workspace.path}</span>
    <span className="mx-2 text-ter" aria-hidden>
      ·
    </span>
    <span className="mono text-ter">{branchLabel(workspace)}</span>
    <div className="flex-1" />
    <span className="text-ter">
      {agentCount} agent{agentCount === 1 ? '' : 's'} · {activeCount} active
    </span>
  </div>
)
