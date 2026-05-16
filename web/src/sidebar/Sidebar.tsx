import { FolderPlus, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
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

const countWorkingMembers = (workers: TeamListItem[] | undefined): number =>
  workers?.filter((worker) => worker.status === 'working').length ?? 0

const workerSummary = (
  workers: TeamListItem[] | undefined,
  t: ReturnType<typeof useI18n>['t']
): string => {
  if (!workers || workers.length === 0) return t('sidebar.noMembers')
  const working = workers.filter((worker) => worker.status === 'working').length
  if (working > 0) return t('sidebar.workingCount', { working, total: workers.length })
  return t('sidebar.teamMemberCount', { count: workers.length })
}

const GITHUB_DISMISSED_KEY = 'hive.sidebar.githubDismissed'

const readGithubDismissed = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(GITHUB_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
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
  const { t } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [githubDismissed, setGithubDismissed] = useState<boolean>(readGithubDismissed)
  const toast = useToast()

  const dismissGithubFooter = () => {
    setGithubDismissed(true)
    try {
      window.localStorage.setItem(GITHUB_DISMISSED_KEY, '1')
    } catch {
      // localStorage unavailable (private mode / sandbox) — silent fallback,
      // state still hides for this session.
    }
  }
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
          message: t('sidebar.removed', { name: workspace.name }),
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({ kind: 'error', message: t('sidebar.deleteFailed', { message }) })
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
      title={
        pendingDelete
          ? t('sidebar.deleteConfirm', { name: pendingDelete.name })
          : t('sidebar.deleteLabel')
      }
      description={
        pendingDelete
          ? t('sidebar.deleteDescription', {
              path: pendingDelete.path,
              summary: workerSummary(workersByWorkspaceId[pendingDelete.id], t),
            })
          : ''
      }
      confirmLabel={deleting ? t('sidebar.deleting') : t('sidebar.deleteLabel')}
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
            className="ws-sidebar-title__text text-xs font-medium text-ter"
            data-testid="workspace-sidebar-title"
          >
            {t('sidebar.workspaces')}
          </span>
          {workspaces && workspaces.length > 0 ? (
            <span className="ws-sidebar-count mono rounded bg-2 px-1.5 py-0.5 text-xs text-ter">
              {workspaces.length}
            </span>
          ) : null}
        </div>
      </div>
      {workspaces === null ? (
        <p className="px-3 py-2 text-xs text-ter">{t('common.loading')}</p>
      ) : workspaces.length === 0 ? (
        <div className="flex-1 px-2 py-4">
          <EmptyState
            title={t('sidebar.noWorkspaces')}
            description={createDisabledReason ?? t('sidebar.noWorkspacesDesc')}
            icon={<FolderPlus size={20} />}
            action={
              <button
                type="button"
                onClick={createDisabled ? undefined : onCreateClick}
                disabled={createDisabled}
                aria-label={t('sidebar.newWorkspace')}
                title={createDisabledReason ?? t('sidebar.newWorkspace')}
                className="icon-btn icon-btn--primary mt-1 flex items-center gap-1.5 px-4 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={14} aria-hidden />
                {t('sidebar.newWorkspace')}
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
            const workingCount = countWorkingMembers(workers)
            return (
              <li key={workspace.id} className="group relative">
                {/* Wide layout — mini avatar + name, path moved to tooltip. */}
                {/* Hidden by `@container ws-sidebar (max-width: 96px)`. */}
                <Tooltip
                  side="right"
                  label={
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{workspace.name}</span>
                      <span className="mono text-ter">{workspace.path}</span>
                    </span>
                  }
                >
                  <button
                    type="button"
                    aria-label={workspace.name}
                    aria-current={isActive ? 'true' : undefined}
                    data-workspace-path={workspace.path}
                    onClick={() => onSelectWorkspace(workspace.id)}
                    className={`ws-row flex w-full items-center gap-2.5 py-1.5 pr-7 pl-2 text-left${
                      isActive ? ' active' : ''
                    }`}
                  >
                    <WorkspaceAvatar
                      workspaceId={workspace.id}
                      name={workspace.name}
                      isActive={isActive}
                      working={hasWorking}
                      workingCount={workingCount}
                      size={22}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        isActive ? 'font-medium text-pri' : 'text-pri'
                      }`}
                    >
                      {workspace.name}
                    </span>
                  </button>
                </Tooltip>
                {/* Compact layout — Discord-style square avatar. Shown by the */}
                {/* same container query when sidebar width is ≤96px. */}
                <Tooltip
                  side="right"
                  label={
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{workspace.name}</span>
                      <span className="mono text-ter">{workspace.path}</span>
                    </span>
                  }
                >
                  <button
                    type="button"
                    aria-label={workspace.name}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onSelectWorkspace(workspace.id)}
                    className="ws-avatar-cell hidden w-full justify-center py-2"
                    data-testid="ws-avatar-cell"
                  >
                    <WorkspaceAvatar
                      workspaceId={workspace.id}
                      name={workspace.name}
                      isActive={isActive}
                      working={hasWorking}
                      workingCount={workingCount}
                    />
                  </button>
                </Tooltip>
                <Tooltip label={t('sidebar.deleteAria', { name: workspace.name })}>
                  <button
                    type="button"
                    aria-label={t('sidebar.deleteAria', { name: workspace.name })}
                    onClick={() => requestDelete(workspace)}
                    className="ws-row-delete absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded text-ter opacity-0 transition-colors hover:text-status-red focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </Tooltip>
              </li>
            )
          })}
          {/* New-workspace CTA lives at the bottom of the list (Discord-style)
              so it appears next to existing workspaces in both wide and compact
              modes, instead of pinned to the sidebar footer. */}
          <li>
            <Tooltip label={createDisabledReason ?? t('sidebar.newWorkspace')}>
              <button
                type="button"
                onClick={createDisabled ? undefined : onCreateClick}
                disabled={createDisabled}
                aria-label={t('sidebar.newWorkspace')}
                /* Keep native `title` as a fallback: Radix Tooltip doesn't
                   reliably surface on a disabled <button> across browsers,
                   so screen-readers and Safari users still get the reason. */
                title={createDisabledReason ?? undefined}
                className="ws-add ws-add--inline mx-3 mt-1 flex items-center justify-center gap-1.5 rounded border border-dashed px-3 py-2 text-xs font-medium text-sec transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <Plus size={14} aria-hidden />
                <span className="ws-add__label">{t('sidebar.newWorkspace')}</span>
              </button>
            </Tooltip>
          </li>
        </ul>
      )}

      {githubDismissed ? null : (
        <div
          className="ws-sidebar-footer group relative"
          style={{ boxShadow: 'inset 0 1px 0 var(--border)' }}
        >
          <a
            href="https://github.com/tt-a1i/hive"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('sidebar.openRepository')}
            title={t('sidebar.openRepository')}
            className="ws-sidebar-footer__link flex items-center gap-2.5 px-3 py-3 text-sm text-ter transition-colors hover:text-pri"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="ws-sidebar-footer__label">GitHub</span>
          </a>
          <button
            type="button"
            aria-label={t('sidebar.dismissRepository')}
            title={t('sidebar.dismissRepository')}
            onClick={dismissGithubFooter}
            className="ws-sidebar-footer__dismiss absolute top-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded text-ter opacity-0 transition-opacity hover:bg-3 hover:text-pri focus:opacity-100 group-hover:opacity-100"
          >
            <X size={10} aria-hidden />
          </button>
        </div>
      )}

      {confirm}
    </nav>
  )
}
