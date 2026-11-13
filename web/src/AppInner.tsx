import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppWorkspaceDialogs } from './AppWorkspaceDialogs.js'
import { type AppViewState, AppWorkspaceLayout } from './AppWorkspaceLayout.js'
import { AppTerminalPanels, AppWorkspaceView } from './AppWorkspaceView.js'
import { DEMO_TASKS_MD } from './demo/demo-fixture.js'
import { useIsMobile } from './mobile/layout-mode.js'
import type { MobileSection } from './mobile/MobileBottomNav.js'
import { useShortcutAction } from './pwa/use-shortcut-action.js'
import { countOpenRootTasks } from './tasks/task-markdown.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useAppShortcuts } from './useAppShortcuts.js'
import { useAppWorkspace } from './useAppWorkspace.js'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard.js'
import { useVersionInfo } from './useVersionInfo.js'
import { useWorkerHighlight } from './useWorkerHighlight.js'
import { useWhatsNew } from './whats-new/useWhatsNew.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkflowFeature } from './workflows/useWorkflowFeature.js'

export const AppInner = () => {
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const [workflowsOpen, setWorkflowsOpen] = useState(false)
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [mobileSection, setMobileSection] = useState<MobileSection>('team')
  const workspace = useAppWorkspace(() => {
    setTaskGraphOpen(false)
    setWorkflowsOpen(false)
  })
  const { activeWorkers, demoMode, bootstrapError, workspaces, effective } = workspace
  const versionInfo = useVersionInfo()
  const wizard = useFirstRunWizard(workspaces)
  const whatsNew = useWhatsNew({
    hasExistingWorkspace: workspaces === null ? null : workspaces.length > 0,
    wizardOpen: wizard.wizardOpen,
  })
  const workflowsEnabled = useWorkflowFeature().enabled
  useEffect(() => {
    if (!workflowsEnabled) {
      setWorkflowsOpen(false)
      setMobileSection((section) => (section === 'flows' ? 'team' : section))
    }
  }, [workflowsEnabled])
  useEffect(() => {
    setActiveWorkerId((current) =>
      current && activeWorkers.some((worker) => worker.id === current) ? current : null
    )
  }, [activeWorkers])
  const triggerAddDialog = useCallback(() => setAddDialogTrigger((value) => value + 1), [])
  useBeforeUnloadGuard(true)
  const tasksFile = useTasksFile(
    demoMode ? null : workspace.activeWorkspaceId,
    demoMode ? DEMO_TASKS_MD : undefined
  )
  const openTaskCount = useMemo(
    () => (effective.effectiveActiveWorkspace ? countOpenRootTasks(tasksFile.content) : 0),
    [effective.effectiveActiveWorkspace, tasksFile.content]
  )
  useAppShortcuts({
    bootstrapError,
    onSelectWorkspace: workspace.selectWorkspace,
    onTriggerAddDialog: triggerAddDialog,
    workspaces: effective.effectiveWorkspaces,
  })
  // Process manifest shortcuts once bootstrap settles, including an offline failure.
  useShortcutAction({
    onAddWorkspace: triggerAddDialog,
    onTryDemo: workspace.enableDemo,
    ready: demoMode || workspaces !== null || bootstrapError !== null,
  })
  const onSelectOwner = useWorkerHighlight()
  const isMobile = useIsMobile()
  const view: AppViewState = {
    addDialogTrigger,
    onAddWorkspace: triggerAddDialog,
    onOpenWorker: setActiveWorkerId,
    taskGraphOpen,
    setTaskGraphOpen,
    workflowsEnabled,
    workflowsOpen,
    setWorkflowsOpen,
    mobileSection,
    setMobileSection,
  }
  return (
    <AppWorkspaceLayout
      workspace={workspace}
      view={view}
      tasksFile={tasksFile}
      openTaskCount={openTaskCount}
      onSelectOwner={onSelectOwner}
      isMobile={isMobile}
      versionInfo={versionInfo}
      workspaceContent={
        <AppWorkspaceView
          workspace={workspace}
          activeWorkerId={activeWorkerId}
          onActiveWorkerChange={setActiveWorkerId}
          onAddWorkspace={triggerAddDialog}
          isMobile={isMobile}
        />
      }
      terminalPanels={<AppTerminalPanels workspace={workspace} />}
      overlays={
        <AppWorkspaceDialogs
          workspace={workspace}
          view={view}
          tasksFile={tasksFile}
          onSelectOwner={onSelectOwner}
          wizard={wizard}
          whatsNew={whatsNew}
          isMobile={isMobile}
        />
      }
    />
  )
}
