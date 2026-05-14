import { FolderPlus, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { useToast } from '../ui/useToast.js'
import { WorkspaceAvatar } from './WorkspaceAvatar.js'

type SidebarProps = {
  activeWorkspaceId: string | null
  createDisabledReason?: string
  onCreateClick: () => void
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void | Promise<void>
  onSelectWorkspace: (workspaceId: string) => void
  workersByWorkspaceId: Record<string, TeamListItem[]>
  workspaces: WorkspaceSummary[] | null
}

const hasWorkingMember = (workers: TeamListItem[] | undefined): boolean =>
  !!workers?.some((worker) => worker.status === 'working')

const workerSummary = (workers: TeamListItem[] | undefined): string => {
  if (!workers || workers.length === 0) return 'no team members yet'
  const working = workers.filter((worker) => worker.status === 'working').length
  if (working > 0) return `${working} of ${workers.length} working`
  return `${workers.length} team member${workers.length === 1 ? '' : 's'}`
}

export const Sidebar = ({
  activeWorkspaceId,
  createDisabledReason,
  onCreateClick,
  onDeleteWorkspace,
  onSelectWorkspace,
  workersByWorkspaceId,
  workspaces,
}: SidebarProps) => {
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()
  const createDisabled = Boolean(createDisabledReason)

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

  const confirm = (
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
  )

  return (
    <nav aria-label="Workspaces" className="flex h-full flex-col">
      <div
        className="flex items-center justify-between gap-2 px-3 pt-3 pb-2"
        style={{ boxShadow: 'inset 0 -1px 0 var(--border)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="ws-sidebar-title__text text-[10px] font-medium uppercase tracking-wider text-ter"
            data-testid="workspace-sidebar-title"
          >
            Workspaces
          </span>
          {workspaces && workspaces.length > 0 ? (
            <span className="ws-sidebar-count mono rounded bg-2 px-1.5 py-0.5 text-[10px] text-ter">
              {workspaces.length}
            </span>
          ) : null}
        </div>
      </div>
      {workspaces === null ? (
        <p className="px-3 py-2 text-xs text-ter">Loading…</p>
      ) : workspaces.length === 0 ? (
        <div className="flex-1 px-2 py-4">
          <EmptyState
            title="No workspaces"
            description="Add one to start. Hive will load .hive/tasks.md and start the Orchestrator."
            icon={<FolderPlus size={20} />}
            action={
              <button
                type="button"
                onClick={createDisabled ? undefined : onCreateClick}
                disabled={createDisabled}
                aria-label="New workspace"
                title={createDisabledReason ?? 'New workspace'}
                className="icon-btn icon-btn--primary mt-1 flex items-center gap-1.5 px-4 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={13} aria-hidden />
                New workspace
              </button>
            }
          />
        </div>
      ) : (
        <ul className="flex-1 scroll-y pb-2">
          {workspaces.map((workspace) => {
            const workers = workersByWorkspaceId[workspace.id]
            const isActive = workspace.id === activeWorkspaceId
            const hasWorking = hasWorkingMember(workers)
            return (
              <li key={workspace.id} className="group relative">
                {/* Wide layout — name + path + inline status dot. Hidden by */}
                {/* `@container ws-sidebar (max-width: 96px)` in globals.css. */}
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
                  <div className="ws-row__path mt-0.5 truncate text-[11px] text-ter">
                    {workspace.path}
                  </div>
                </button>
                {/* Compact layout — Discord-style square avatar. Shown by the */}
                {/* same container query when sidebar width is ≤96px. */}
                <button
                  type="button"
                  aria-label={workspace.name}
                  aria-current={isActive ? 'true' : undefined}
                  title={`${workspace.name}\n${workspace.path}`}
                  onClick={() => onSelectWorkspace(workspace.id)}
                  className="ws-avatar-cell hidden w-full justify-center py-2"
                  data-testid="ws-avatar-cell"
                >
                  <WorkspaceAvatar
                    workspaceId={workspace.id}
                    name={workspace.name}
                    isActive={isActive}
                    working={hasWorking}
                  />
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
          {/* New-workspace CTA lives at the bottom of the list (Discord-style)
              so it appears next to existing workspaces in both wide and compact
              modes, instead of pinned to the sidebar footer. */}
          <li>
            <button
              type="button"
              onClick={createDisabled ? undefined : onCreateClick}
              disabled={createDisabled}
              aria-label="New workspace"
              title={createDisabledReason ?? 'New workspace'}
              className="ws-add ws-add--inline mx-3 mt-1 flex items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs font-medium text-sec transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              <Plus size={13} aria-hidden />
              <span className="ws-add__label">New workspace</span>
            </button>
          </li>
        </ul>
      )}

      {confirm}
    </nav>
  )
}
