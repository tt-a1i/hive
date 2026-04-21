import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

type SidebarProps = {
  activeWorkspaceId: string | null
  onCreateClick: () => void
  onSelectWorkspace: (workspaceId: string) => void
  workersByWorkspaceId: Record<string, TeamListItem[]>
  workspaces: WorkspaceSummary[] | null
}

const hasWorkingWorker = (workers: TeamListItem[] | undefined): boolean =>
  !!workers?.some((worker) => worker.status === 'working')

const branchLabel = (workspace: WorkspaceSummary): string => workspace.path.split('/').pop() ?? ''

export const Sidebar = ({
  activeWorkspaceId,
  onCreateClick,
  onSelectWorkspace,
  workersByWorkspaceId,
  workspaces,
}: SidebarProps) => (
  <nav aria-label="Workspaces" className="flex h-full flex-col">
    <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-ter">
      Workspaces
    </div>
    {workspaces === null ? (
      <p className="px-3 py-2 text-xs text-ter">Loading…</p>
    ) : workspaces.length === 0 ? (
      <p className="px-3 py-2 text-xs text-ter">No workspaces yet</p>
    ) : (
      <ul className="flex-1 scroll-y">
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeWorkspaceId
          const working = hasWorkingWorker(workersByWorkspaceId[workspace.id])
          return (
            <li key={workspace.id}>
              <button
                type="button"
                aria-label={workspace.name}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelectWorkspace(workspace.id)}
                className={`ws-row block w-full px-3 py-2.5 text-left${isActive ? ' active' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <span className={isActive ? 'font-medium text-pri' : 'text-pri'}>
                    {workspace.name}
                  </span>
                  {working ? <span className="dot pulse-green" title="worker working" /> : null}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-ter">{workspace.path}</div>
                <div className="mono mt-0.5 text-[10px] text-ter">{branchLabel(workspace)}</div>
              </button>
            </li>
          )
        })}
      </ul>
    )}
    <button
      type="button"
      onClick={onCreateClick}
      aria-label="New workspace"
      className="m-2 flex items-center justify-center gap-1.5 rounded border border-dashed px-3 py-2 text-xs text-sec hover:bg-3 hover:text-pri"
      style={{ borderColor: 'var(--border)' }}
    >
      <span className="text-base leading-none" aria-hidden>
        +
      </span>
      Add Workspace
    </button>
  </nav>
)
