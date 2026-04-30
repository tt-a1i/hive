import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { useToast } from '../ui/useToast.js'

type SidebarProps = {
  activeWorkspaceId: string | null
  onCreateClick: () => void
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void | Promise<void>
  onSelectWorkspace: (workspaceId: string) => void
  workersByWorkspaceId: Record<string, TeamListItem[]>
  workspaces: WorkspaceSummary[] | null
}

const hasWorkingMember = (workers: TeamListItem[] | undefined): boolean =>
  !!workers?.some((worker) => worker.status === 'working')

const branchLabel = (workspace: WorkspaceSummary): string => workspace.path.split('/').pop() ?? ''

const workerSummary = (workers: TeamListItem[] | undefined): string => {
  if (!workers || workers.length === 0) return 'no team members yet'
  const working = workers.filter((worker) => worker.status === 'working').length
  if (working > 0) return `${working} of ${workers.length} working`
  return `${workers.length} team member${workers.length === 1 ? '' : 's'}`
}

export const Sidebar = ({
  activeWorkspaceId,
  onCreateClick,
  onDeleteWorkspace,
  onSelectWorkspace,
  workersByWorkspaceId,
  workspaces,
}: SidebarProps) => {
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  const requestDelete = (workspace: WorkspaceSummary) => {
    setPendingDelete(workspace)
  }

  const confirmDelete = () => {
    if (!pendingDelete || deleting) return
    const workspace = pendingDelete
    setDeleting(true)
    void Promise.resolve(onDeleteWorkspace(workspace))
      .then(() => {
        toast.show({
          kind: 'success',
          message: `Removed workspace "${workspace.name}".`,
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({ kind: 'error', message: `Failed to delete: ${message}` })
      })
      .finally(() => {
        setDeleting(false)
        setPendingDelete(null)
      })
  }

  return (
    <nav aria-label="Workspaces" className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5 pr-11">
        <span className="text-[10px] font-medium uppercase tracking-wider text-ter">
          Workspaces
        </span>
        {workspaces && workspaces.length > 0 ? (
          <span className="mono text-[10px] text-ter">{workspaces.length}</span>
        ) : null}
      </div>
      {workspaces === null ? (
        <p className="px-3 py-2 text-xs text-ter">Loading…</p>
      ) : workspaces.length === 0 ? (
        <div className="flex-1 px-2 py-4">
          <EmptyState
            title="No workspaces"
            description="Add one to start. Hive will load tasks.md and start the Orchestrator."
          />
        </div>
      ) : (
        <ul className="flex-1 scroll-y">
          {workspaces.map((workspace) => {
            const workers = workersByWorkspaceId[workspace.id]
            const isActive = workspace.id === activeWorkspaceId
            const hasWorking = hasWorkingMember(workers)
            return (
              <li key={workspace.id} className="group relative">
                <button
                  type="button"
                  aria-label={workspace.name}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => onSelectWorkspace(workspace.id)}
                  className={`ws-row block w-full py-2.5 pr-9 pl-3 text-left${
                    isActive ? ' active' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        isActive ? 'font-medium text-pri' : 'text-pri'
                      }`}
                    >
                      {workspace.name}
                    </span>
                    {hasWorking ? (
                      <span
                        className="status-dot status-dot--working"
                        role="img"
                        aria-label="At least one team member is working"
                        title="At least one team member is working"
                      />
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ter">{workspace.path}</div>
                  <div className="mono mt-0.5 truncate text-[10px] text-ter">
                    {branchLabel(workspace)}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`Delete workspace ${workspace.name}`}
                  title={`Delete workspace ${workspace.name}`}
                  onClick={() => requestDelete(workspace)}
                  className="ws-row-delete absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-md text-ter opacity-0 transition-colors hover:text-status-red focus:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={13} aria-hidden />
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
        className="ws-add m-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs font-medium text-sec transition-colors"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <Plus size={13} aria-hidden />
        Add Workspace
      </button>

      <Confirm
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
        title={pendingDelete ? `Delete workspace "${pendingDelete.name}"?` : 'Delete workspace?'}
        description={
          pendingDelete
            ? `This stops its agents and removes it from Hive. The folder on disk (${pendingDelete.path}) is left untouched. ${workerSummary(workersByWorkspaceId[pendingDelete.id])}.`
            : ''
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete workspace'}
        confirmKind="danger"
        onConfirm={confirmDelete}
      />
    </nav>
  )
}
