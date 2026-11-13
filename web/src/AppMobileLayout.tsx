import type { ReactNode } from 'react'
import type { AppWorkspaceLayoutProps } from './AppWorkspaceLayout.js'
import { MobileSettingsSection } from './mobile/MobileSettingsSection.js'
import { MobileShell } from './mobile/MobileShell.js'
import { MobileTasksSection } from './mobile/MobileTasksSection.js'
import { MobileWorkspaceSwitcher } from './mobile/MobileWorkspaceSwitcher.js'
import { SettingsMenu } from './settings/SettingsMenu.js'

/** Adapt shared workspace slots to the existing mobile shell without owning its internals. */
export const AppMobileLayout = ({
  workspace,
  view,
  tasksFile,
  openTaskCount,
  onSelectOwner,
  workspaceContent,
  terminalPanels,
  overlays,
  banner,
}: AppWorkspaceLayoutProps & { banner: ReactNode }) => {
  const { effective, runtimeOffline, demoMode } = workspace
  return (
    <MobileShell
      workspaceSwitcher={
        runtimeOffline ? undefined : (
          <MobileWorkspaceSwitcher
            activeWorkspaceId={effective.effectiveActiveWorkspaceId}
            workspaces={effective.effectiveWorkspaces}
            workersByWorkspaceId={effective.effectiveWorkersByWorkspaceId}
            createDisabledReason={workspace.bootstrapError ?? undefined}
            onCreateClick={view.onAddWorkspace}
            onDeleteWorkspace={workspace.deleteWorkspace}
            onSelectWorkspace={workspace.selectWorkspace}
          />
        )
      }
      topbarActions={runtimeOffline ? undefined : <SettingsMenu />}
      openTaskCount={openTaskCount}
      workingCount={workspace.activeWorkers.filter((worker) => worker.status === 'working').length}
      banner={banner}
      terminalPanels={terminalPanels}
      fullBleed={runtimeOffline ? workspaceContent : undefined}
      team={runtimeOffline ? null : workspaceContent}
      tasks={
        runtimeOffline ? null : (
          <MobileTasksSection
            tasksFile={tasksFile}
            workspacePath={effective.effectiveActiveWorkspace?.path ?? null}
            workers={workspace.activeWorkers}
            onSelectOwner={onSelectOwner}
            onAddWorkspace={view.onAddWorkspace}
            demoMode={demoMode}
          />
        )
      }
      settings={
        runtimeOffline || !demoMode ? undefined : (
          <MobileSettingsSection
            demoMode={demoMode}
            onTryDemo={workspace.enableDemo}
            onExitDemo={workspace.exitDemo}
          />
        )
      }
      activeSection={view.mobileSection}
      onSectionChange={view.setMobileSection}
      overlays={overlays}
    />
  )
}
