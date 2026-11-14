import { type Dispatch, type ReactNode, type SetStateAction, useSyncExternalStore } from 'react'
import { AppMobileLayout } from './AppMobileLayout.js'
import { ActionCenterTopbarButton } from './action-center/ActionCenterStrip.js'
import { MainLayout } from './layout/MainLayout.js'
import { useWorkspaceSidebarResize } from './layout/useWorkspaceSidebarResize.js'
import type { MobileSection } from './mobile/MobileBottomNav.js'
import { MobileReconnectBanner } from './mobile/MobileReconnectBanner.js'
import { DesktopRemoteSessionNotifications } from './notifications/DesktopRemoteSessionNotifications.js'
import { UpdateAvailableToast } from './pwa/UpdateAvailableToast.js'
import { RemotePairingConfirm } from './remote/RemotePairingConfirm.js'
import { Sidebar } from './sidebar/Sidebar.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from './transport/connection-status-store.js'
import { PackageUpdateToast } from './update/PackageUpdateToast.js'
import type { AppWorkspace } from './useAppWorkspace.js'
import type { useVersionInfo } from './useVersionInfo.js'
import { OpenWorkspaceButton } from './workspace/OpenWorkspaceButton.js'

export interface AppViewState {
  addDialogTrigger: number
  onAddWorkspace: () => void
  onOpenWorker: (id: string | null) => void
  taskGraphOpen: boolean
  setTaskGraphOpen: Dispatch<SetStateAction<boolean>>
  workflowsEnabled: boolean
  workflowsOpen: boolean
  setWorkflowsOpen: Dispatch<SetStateAction<boolean>>
  mobileSection: MobileSection
  setMobileSection: Dispatch<SetStateAction<MobileSection>>
}
export interface AppWorkspaceLayoutProps {
  workspace: AppWorkspace
  view: AppViewState
  tasksFile: ReturnType<typeof useTasksFile>
  openTaskCount: number
  onSelectOwner: (workerName: string) => void
  isMobile: boolean
  versionInfo: ReturnType<typeof useVersionInfo>
  workspaceContent: ReactNode
  terminalPanels: ReactNode
  overlays: ReactNode
}

/** Keep workspace content, terminal lifetime, and global notifications shared across layouts. */
export const AppWorkspaceLayout = (props: AppWorkspaceLayoutProps) => {
  const { workspace, view, isMobile, versionInfo } = props
  const { effective, runtimeOffline, demoMode, activeId } = workspace
  const sidebarResize = useWorkspaceSidebarResize()
  const connectionStatus = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  return (
    <>
      {isMobile ? (
        <AppMobileLayout {...props} banner={<MobileReconnectBanner status={connectionStatus} />} />
      ) : (
        <MainLayout
          hideTopbarActions={!effective.effectiveActiveWorkspace}
          onToggleTaskGraph={() => view.setTaskGraphOpen((value) => !value)}
          openTaskCount={props.openTaskCount}
          topbarActions={
            <>
              <OpenWorkspaceButton workspace={effective.effectiveActiveWorkspace} />
              {runtimeOffline || demoMode || !activeId ? null : (
                <ActionCenterTopbarButton
                  key={activeId}
                  workspaceId={activeId}
                  onOpenWorker={view.onOpenWorker}
                />
              )}
            </>
          }
          taskGraphOpen={view.taskGraphOpen}
          {...(demoMode || !view.workflowsEnabled
            ? {}
            : { onToggleWorkflows: () => view.setWorkflowsOpen((value) => !value) })}
          workflowsOpen={view.workflowsOpen}
          sidebarResize={sidebarResize}
          sidebar={
            <Sidebar
              activeWorkspaceId={effective.effectiveActiveWorkspaceId}
              collapsed={sidebarResize.collapsed}
              {...(workspace.bootstrapError !== null
                ? { createDisabledReason: workspace.bootstrapError }
                : {})}
              onCreateClick={view.onAddWorkspace}
              onDeleteWorkspace={workspace.deleteWorkspace}
              onSelectWorkspace={workspace.selectWorkspace}
              onToggleCollapse={sidebarResize.toggleCollapsed}
              workersByWorkspaceId={effective.effectiveWorkersByWorkspaceId}
              workspaces={effective.effectiveWorkspaces}
            />
          }
          versionInfo={versionInfo}
        >
          {props.workspaceContent}
          {props.terminalPanels}
          {props.overlays}
        </MainLayout>
      )}
      <PackageUpdateToast versionInfo={versionInfo} />
      <UpdateAvailableToast terminalRuns={workspace.terms.terminalRuns} />
      <RemotePairingConfirm />
      {!isMobile ? <DesktopRemoteSessionNotifications /> : null}
    </>
  )
}
