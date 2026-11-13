import { lazy, Suspense } from 'react'
import { AppOverlays } from './AppOverlays.js'
import type { AppWorkspaceLayoutProps } from './AppWorkspaceLayout.js'
import type { useWhatsNew } from './whats-new/useWhatsNew.js'
import type { useFirstRunWizard } from './wizard/useFirstRunWizard.js'

// Keep experimental workflows out of the initial bundle and load only while open.
const WorkflowsDrawer = lazy(() =>
  import('./workflows/WorkflowsDrawer.js').then((module) => ({ default: module.WorkflowsDrawer }))
)

export const AppWorkspaceDialogs = ({
  workspace,
  view,
  tasksFile,
  onSelectOwner,
  wizard,
  whatsNew,
  isMobile,
}: Pick<
  AppWorkspaceLayoutProps,
  'workspace' | 'view' | 'tasksFile' | 'onSelectOwner' | 'isMobile'
> & {
  wizard: ReturnType<typeof useFirstRunWizard>
  whatsNew: ReturnType<typeof useWhatsNew>
}) => (
  <>
    <AppOverlays
      addDialogTrigger={view.addDialogTrigger}
      wizardOpen={wizard.wizardOpen}
      whatsNewOpen={whatsNew.open}
      whatsNewEntries={whatsNew.entries}
      onCloseWhatsNew={whatsNew.close}
      onAddWorkspace={view.onAddWorkspace}
      onCloseTaskGraph={() => view.setTaskGraphOpen(false)}
      onCloseWizard={wizard.closeWizard}
      onCreateWorkspace={workspace.create.createNewWorkspace}
      onTryDemo={workspace.enableDemo}
      taskGraphOpen={view.taskGraphOpen}
      tasksFile={tasksFile}
      workspacePath={workspace.effective.effectiveActiveWorkspace?.path ?? null}
      workers={workspace.activeWorkers}
      onSelectOwner={onSelectOwner}
    />
    {!isMobile && view.workflowsOpen && !workspace.demoMode && view.workflowsEnabled ? (
      <Suspense fallback={null}>
        <WorkflowsDrawer
          open
          onClose={() => view.setWorkflowsOpen(false)}
          workspaceId={workspace.activeWorkspaceId ?? null}
        />
      </Suspense>
    ) : null}
  </>
)
