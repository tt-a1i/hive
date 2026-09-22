import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppOverlays } from './AppOverlays.js'
import { AppWorkspaceContent } from './AppWorkspaceContent.js'
import { ActionCenterTopbarButton } from './action-center/ActionCenterStrip.js'
import { DEMO_TASKS_MD } from './demo/demo-fixture.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { useEffectiveWorkspaceState } from './demo/useEffectiveWorkspaceState.js'
import { MainLayout } from './layout/MainLayout.js'
import { useWorkspaceSidebarResize } from './layout/useWorkspaceSidebarResize.js'
import { useIsMobile } from './mobile/layout-mode.js'
import type { MobileSection } from './mobile/MobileBottomNav.js'
import { MobileReconnectBanner } from './mobile/MobileReconnectBanner.js'
import { MobileSettingsSection } from './mobile/MobileSettingsSection.js'
import { MobileShell } from './mobile/MobileShell.js'
import { MobileTasksSection } from './mobile/MobileTasksSection.js'
import { MobileWorkspaceSwitcher } from './mobile/MobileWorkspaceSwitcher.js'
import { DesktopRemoteSessionNotifications } from './notifications/DesktopRemoteSessionNotifications.js'
import { RuntimeOfflinePage } from './pwa/RuntimeOfflinePage.js'
import { UpdateAvailableToast } from './pwa/UpdateAvailableToast.js'
import { useShortcutAction } from './pwa/use-shortcut-action.js'
import { RemotePairingConfirm } from './remote/RemotePairingConfirm.js'
import { SettingsMenu } from './settings/SettingsMenu.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { countOpenRootTasks } from './tasks/task-markdown.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { orchestratorAgentId, useTerminalRuns } from './terminal/useTerminalRuns.js'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from './transport/connection-status-store.js'
import { useToast } from './ui/useToast.js'
import { PackageUpdateToast } from './update/PackageUpdateToast.js'
import { useAppShortcuts } from './useAppShortcuts.js'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useVersionInfo } from './useVersionInfo.js'
import { useWorkerHighlight } from './useWorkerHighlight.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import { useWhatsNew } from './whats-new/useWhatsNew.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkerActions } from './worker/useWorkerActions.js'
import { useWorkflowFeature } from './workflows/useWorkflowFeature.js'
import { OpenWorkspaceButton } from './workspace/OpenWorkspaceButton.js'

// Workflows are feature-flagged off by default — keep the whole drawer module
// out of the initial chunk. It loads on first drawer open / first Flows visit.
const WorkflowsDrawer = lazy(() =>
  import('./workflows/WorkflowsDrawer.js').then((m) => ({ default: m.WorkflowsDrawer }))
)

const WorkspaceMemoryDrawer = lazy(() =>
  import('./memory/WorkspaceMemoryDrawer.js').then((m) => ({ default: m.WorkspaceMemoryDrawer }))
)

export const AppInner = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const { demoMode, enableDemo, exitDemo } = useDemoMode()
  const localPollIds = demoMode || !workspaces ? [] : workspaces.map(({ id }) => id)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(localPollIds, {
    activeWorkspaceId,
  })
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [workflowsOpen, setWorkflowsOpen] = useState(false)
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  // Active mobile bottom-nav section. Lifted here (not internal to MobileShell)
  // so a full-screen page can route back — e.g. closing the Tasks drawer
  // returns to Team. Inert on the desktop branch.
  const [mobileSection, setMobileSection] = useState<MobileSection>('team')
  const sidebarResize = useWorkspaceSidebarResize()
  const toast = useToast()
  const versionInfo = useVersionInfo()
  const { wizardOpen, closeWizard } = useFirstRunWizard(workspaces)
  const whatsNew = useWhatsNew({
    hasExistingWorkspace: workspaces === null ? null : workspaces.length > 0,
    wizardOpen,
  })
  // Workflows are an experimental opt-in (off by default). While disabled the
  // topbar Workflows button + its drawer are hidden entirely.
  const workflowFeature = useWorkflowFeature()
  const workflowsEnabled = workflowFeature.enabled
  // If the feature is turned off while the drawer is open, close it so it
  // doesn't silently re-open when the feature is re-enabled.
  useEffect(() => {
    if (!workflowsEnabled) {
      setWorkflowsOpen(false)
      // Don't strand the user on a Flows tab that just disappeared.
      setMobileSection((section) => (section === 'flows' ? 'team' : section))
    }
  }, [workflowsEnabled])
  const triggerAddDialog = useCallback(() => setAddDialogTrigger((v) => v + 1), [])
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const onBootstrapError = useCallback(
    (message: string) => {
      setBootstrapError(message)
      toast.show({ kind: 'error', message })
    },
    [toast]
  )
  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onBootstrapError)
  const wsState = { demoMode, workspaces, activeWorkspaceId, workersByWorkspaceId }
  const eff = useEffectiveWorkspaceState(wsState)
  const activeId = eff.effectiveActiveWorkspace?.id
  const activeWorkers = activeId ? (eff.effectiveWorkersByWorkspaceId[activeId] ?? []) : []
  useEffect(() => {
    setActiveWorkerId((current) =>
      current && activeWorkers.some((worker) => worker.id === current) ? current : null
    )
  }, [activeWorkers])
  const polledTerminalRuns = useTerminalRuns(eff.pollWorkspaceId)
  const terms = useOptimisticTerminalRuns(eff.pollWorkspaceId, polledTerminalRuns, activeWorkers)
  const wsCreate = useWorkspaceCreate({
    onWorkspaceCreated: (ws) => {
      setWorkspaces((c) => (c === null ? [ws] : [...c, ws]))
      selectWorkspace(ws.id)
      setWorkersByWorkspaceId((c) => ({ ...c, [ws.id]: [] }))
    },
    onError: (message) => toast.show({ kind: 'error', message }),
    onOrchestratorRunStarted: (workspaceId, runId) =>
      terms.recordOptimisticRun({
        agentId: orchestratorAgentId(workspaceId),
        agentName: 'Orchestrator',
        runId,
        status: 'starting',
        workspaceId,
      }),
  })
  // Always confirm on close. Browsers gate beforeunload on prior page
  // interaction so fresh tabs still close cleanly, but every closure that
  // does fire the prompt now goes through it — including the PWA close
  // shortcut (Cmd-W on macOS, Ctrl-W on Windows/Linux).
  useBeforeUnloadGuard(true)
  const tasksFile = useTasksFile(
    demoMode ? null : (activeWorkspaceId ?? null),
    demoMode ? DEMO_TASKS_MD : undefined
  )
  const openTaskCount = useMemo(
    () => (eff.effectiveActiveWorkspace ? countOpenRootTasks(tasksFile.content) : 0),
    [eff.effectiveActiveWorkspace, tasksFile.content]
  )
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    onWorkerDeleted: terms.forgetOptimisticAgent,
    onWorkerRunClosed: terms.forgetOptimisticRun,
    onWorkerStartFailed: (message) => toast.show({ kind: 'error', message }),
    onWorkerRunStarted: terms.recordOptimisticRun,
    setWorkersByWorkspaceId,
    workers: activeWorkers,
  })
  const deleteWorkspace = useWorkspaceDelete({
    activeWorkspaceId,
    onActiveDeleted: () => {
      setMemoryOpen(false)
      setTaskGraphOpen(false)
      setWorkflowsOpen(false)
    },
    selectWorkspace,
    setWorkersByWorkspaceId,
    setWorkspaces,
    workspaces,
  })
  useAppShortcuts({
    bootstrapError,
    onSelectWorkspace: selectWorkspace,
    onTriggerAddDialog: triggerAddDialog,
    workspaces: eff.effectiveWorkspaces,
  })
  // PWA manifest shortcuts route through `?action=...` query params. Wait for
  // bootstrap to *settle* (success OR explicit error) so the dispatcher fires
  // even when the daemon is down — that's exactly when `Try Demo` is most
  // useful, and a stuck-on-loading state would make the shortcut a dead URL.
  useShortcutAction({
    onAddWorkspace: triggerAddDialog,
    onTryDemo: enableDemo,
    ready: demoMode || workspaces !== null || bootstrapError !== null,
  })
  const handleSelectOwner = useWorkerHighlight()
  // Only escalate to the full-screen offline page when bootstrap explicitly
  // failed AND we have no cached workspace data to fall back on AND the user
  // isn't already in demo mode. Mid-session API failures keep the existing
  // toast-based handling.
  const runtimeOffline = bootstrapError !== null && !demoMode && workspaces === null
  const isMobile = useIsMobile()
  // Tunnel connection health (null on desktop/loopback — the store is never fed
  // there, so the banner stays absent and desktop renders are unaffected).
  // Hook call is unconditional; JSX is only built on mobile (no-op on desktop).
  const connectionStatus = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  const connectionBanner = isMobile ? <MobileReconnectBanner status={connectionStatus} /> : null
  // Terminal panels live here (not inside AppWorkspaceContent) so the xterm
  // instances survive mobile bottom-nav tab switches. MobileShell renders them
  // via terminalPanels (always-mounted slot); desktop renders as a sibling.
  const activeOptimisticRuns = activeId ? (terms.optimisticRunsByWorkspaceId[activeId] ?? []) : []
  const shouldMountTerminalPanels =
    !runtimeOffline &&
    !demoMode &&
    activeId !== undefined &&
    (terms.terminalRuns.length > 0 || activeOptimisticRuns.length > 0)
  const terminalPanels = shouldMountTerminalPanels ? (
    <WorkspaceTerminalPanels
      key={`terminal-${activeId}`}
      onTerminalRunExited={terms.forgetOptimisticRun}
      optimisticRuns={activeOptimisticRuns}
      terminalRuns={terms.terminalRuns}
      workspaceId={activeId}
    />
  ) : null
  // Shared layout-agnostic nodes — computed once and rendered by BOTH the
  // desktop MainLayout branch and the MobileShell branch so the two can never
  // drift apart (the mobile shell hosts the SAME instances; never re-wires).
  const workspaceContent = runtimeOffline ? (
    <RuntimeOfflinePage onTryDemo={enableDemo} />
  ) : (
    <AppWorkspaceContent
      activeId={activeId}
      activeWorkspace={eff.effectiveActiveWorkspace}
      activeWorkerId={activeWorkerId}
      bootstrapError={bootstrapError}
      demoMode={demoMode}
      workspacesLoading={!demoMode && workspaces === null}
      onActiveWorkerChange={setActiveWorkerId}
      onDeleteWorkspace={deleteWorkspace}
      onExitDemo={exitDemo}
      onOrchestratorRunClosed={terms.forgetOptimisticRun}
      onRequestAddWorkspace={triggerAddDialog}
      onShellRunClosed={terms.forgetOptimisticRun}
      onShellRunStarted={(workspaceId, run) =>
        terms.recordOptimisticRun({
          agentId: run.agent_id,
          agentName: run.agent_name,
          runId: run.run_id,
          status: run.status,
          terminalInputProfile: run.terminal_input_profile ?? 'default',
          workspaceId,
        })
      }
      onTryDemo={enableDemo}
      orchestratorAutostartErrors={wsCreate.orchestratorAutostartErrors}
      recordOrchestratorResult={wsCreate.recordOrchestratorResult}
      terminalRuns={terms.terminalRuns}
      workerActions={workerActions}
      workers={activeWorkers}
      showInlineActionCenter={isMobile}
    />
  )
  const appOverlays = (
    <AppOverlays
      addDialogTrigger={addDialogTrigger}
      wizardOpen={wizardOpen}
      whatsNewOpen={whatsNew.open}
      whatsNewEntries={whatsNew.entries}
      onCloseWhatsNew={whatsNew.close}
      onAddWorkspace={triggerAddDialog}
      onCloseTaskGraph={() => setTaskGraphOpen(false)}
      onCloseWizard={closeWizard}
      onCreateWorkspace={wsCreate.createNewWorkspace}
      onTryDemo={enableDemo}
      taskGraphOpen={taskGraphOpen}
      tasksFile={tasksFile}
      workspacePath={eff.effectiveActiveWorkspace?.path ?? null}
      workers={activeWorkers}
      onSelectOwner={handleSelectOwner}
    />
  )
  // Mounted only while open so the lazy chunk isn't fetched at app start
  // (rendering a lazy component triggers its import even with open=false).
  const workflowsDrawer =
    workflowsOpen && !demoMode && workflowsEnabled ? (
      <Suspense fallback={null}>
        <WorkflowsDrawer
          open
          onClose={() => setWorkflowsOpen(false)}
          workspaceId={activeWorkspaceId ?? null}
        />
      </Suspense>
    ) : null
  const memoryDrawer =
    memoryOpen && !demoMode ? (
      <Suspense fallback={null}>
        <WorkspaceMemoryDrawer
          open
          onClose={() => setMemoryOpen(false)}
          workspaceId={activeWorkspaceId ?? null}
        />
      </Suspense>
    ) : null
  const sidebar = (
    <Sidebar
      activeWorkspaceId={eff.effectiveActiveWorkspaceId}
      collapsed={sidebarResize.collapsed}
      {...(bootstrapError !== null ? { createDisabledReason: bootstrapError } : {})}
      onCreateClick={triggerAddDialog}
      onDeleteWorkspace={deleteWorkspace}
      onSelectWorkspace={selectWorkspace}
      onToggleCollapse={sidebarResize.toggleCollapsed}
      workersByWorkspaceId={eff.effectiveWorkersByWorkspaceId}
      workspaces={eff.effectiveWorkspaces}
    />
  )
  const topbarActions = (
    <>
      <OpenWorkspaceButton workspace={eff.effectiveActiveWorkspace} />
      {runtimeOffline || demoMode || !activeId ? null : (
        <ActionCenterTopbarButton
          key={activeId}
          workspaceId={activeId}
          onOpenWorker={setActiveWorkerId}
        />
      )}
    </>
  )
  if (isMobile) {
    return (
      <>
        <MobileShell
          workspaceSwitcher={
            runtimeOffline ? undefined : (
              <MobileWorkspaceSwitcher
                activeWorkspaceId={eff.effectiveActiveWorkspaceId}
                workspaces={eff.effectiveWorkspaces}
                workersByWorkspaceId={eff.effectiveWorkersByWorkspaceId}
                createDisabledReason={bootstrapError ?? undefined}
                onCreateClick={triggerAddDialog}
                onDeleteWorkspace={deleteWorkspace}
                onSelectWorkspace={selectWorkspace}
              />
            )
          }
          topbarActions={
            runtimeOffline ? undefined : (
              <>
                {/* No OpenWorkspaceButton on mobile — "open in editor" targets the
                    host machine, which a phone user isn't sitting at. */}
                <SettingsMenu />
              </>
            )
          }
          openTaskCount={openTaskCount}
          workingCount={activeWorkers.filter((w) => w.status === 'working').length}
          banner={connectionBanner}
          terminalPanels={terminalPanels}
          fullBleed={runtimeOffline ? workspaceContent : undefined}
          team={runtimeOffline ? null : workspaceContent}
          tasks={
            runtimeOffline ? null : (
              <MobileTasksSection
                tasksFile={tasksFile}
                workspacePath={eff.effectiveActiveWorkspace?.path ?? null}
                workers={activeWorkers}
                onSelectOwner={handleSelectOwner}
                onAddWorkspace={triggerAddDialog}
                demoMode={demoMode}
              />
            )
          }
          settings={
            // Settings tab hidden on phones for now (user call 2026-06):
            // everything in it is desktop business. Demo mode still needs the
            // exit toggle, so demo keeps the tab.
            runtimeOffline || !demoMode ? undefined : (
              <MobileSettingsSection
                demoMode={demoMode}
                onTryDemo={enableDemo}
                onExitDemo={exitDemo}
              />
            )
          }
          activeSection={mobileSection}
          onSectionChange={setMobileSection}
          overlays={appOverlays}
        />
        <PackageUpdateToast versionInfo={versionInfo} />
        <UpdateAvailableToast terminalRuns={terms.terminalRuns} />
        {/* Trust-root pairing confirm — rendered on mobile too but internally
            gated to a local desktop actor (M4 daemon 403); never fires here. */}
        <RemotePairingConfirm />
      </>
    )
  }
  return (
    <>
      <MainLayout
        hideTopbarActions={!eff.effectiveActiveWorkspace}
        memoryOpen={memoryOpen}
        {...(demoMode ? {} : { onToggleMemory: () => setMemoryOpen((value) => !value) })}
        onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
        openTaskCount={openTaskCount}
        topbarActions={topbarActions}
        taskGraphOpen={taskGraphOpen}
        {...(demoMode || !workflowsEnabled
          ? {}
          : { onToggleWorkflows: () => setWorkflowsOpen((value) => !value) })}
        workflowsOpen={workflowsOpen}
        sidebarResize={sidebarResize}
        sidebar={sidebar}
        versionInfo={versionInfo}
      >
        {workspaceContent}
        {terminalPanels}
        {appOverlays}
        {memoryDrawer}
        {workflowsDrawer}
      </MainLayout>
      <PackageUpdateToast versionInfo={versionInfo} />
      <UpdateAvailableToast terminalRuns={terms.terminalRuns} />
      {/* Trust-root pairing confirm — top level so it pops even when the
          Settings popover is closed (a phone may finish its handshake any time). */}
      <RemotePairingConfirm />
      {/* Desktop-only: alert the person at the keyboard when a remote device
          connects. Never mounted in MobileShell. */}
      <DesktopRemoteSessionNotifications />
    </>
  )
}
