import { Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { ActionCenterStrip } from './action-center/ActionCenterStrip.js'
import {
  isWorkspaceShellRun,
  type OrchestratorStartResult,
  renameWorker,
  type TerminalRunSummary,
} from './api.js'
import { useI18n } from './i18n.js'
import {
  setMobileFocusMode,
  toggleMobileFocusMode,
  useMobileFocusMode,
} from './mobile/focus-mode.js'
import { useIsMobile } from './mobile/layout-mode.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { TerminalBottomPanel } from './terminal/TerminalBottomPanel.js'
import { useTerminalPanelTabs } from './terminal/useTerminalPanelTabs.js'
import { findRunByAgentId } from './terminal/useTerminalRuns.js'
import { useWorkspaceShellLauncher } from './terminal/useWorkspaceShellLauncher.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import { ExternalControllerPane } from './worker/ExternalControllerPane.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import type { WorkerActions } from './worker/useWorkerActions.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkersPane } from './worker/WorkersPane.js'

const AddWorkerDialog = lazy(() =>
  import('./worker/AddWorkerDialog.js').then((module) => ({ default: module.AddWorkerDialog }))
)
const WorkerModal = lazy(() =>
  import('./worker/WorkerModal.js').then((module) => ({ default: module.WorkerModal }))
)

type WorkspaceDetailProps = {
  activeWorkerId?: string | null
  onCreateWorker: WorkerActions['createWorker']
  onDeleteWorker: (workerId: string) => Promise<void>
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onUpdateWorkerAvatar: WorkerActions['updateWorkerAvatar']
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onStopWorker: (runId: string) => Promise<{ error: string | null }>
  onRestartWorker: (
    workerId: string,
    runId: string
  ) => Promise<{ error: string | null; runId: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onOrchestratorRunClosed?: (workspaceId: string, runId: string) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed?: (workspaceId: string, runId: string) => void
  onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  onTryDemo?: () => void
  welcomeDisabledReason?: string
  orchestratorAutostartError: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
  onActiveWorkerChange?: (workerId: string | null) => void
  showInlineActionCenter?: boolean
}

export const WorkspaceDetail = ({
  activeWorkerId: controlledActiveWorkerId,
  onCreateWorker,
  onDeleteWorker,
  onDeleteWorkspace,
  onUpdateWorkerAvatar,
  onStartWorker,
  onStopWorker,
  onRestartWorker,
  onOrchestratorResult,
  onOrchestratorRunClosed,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onTryDemo,
  welcomeDisabledReason,
  orchestratorAutostartError,
  terminalRuns,
  workers,
  workspace,
  onActiveWorkerChange,
  showInlineActionCenter = true,
}: WorkspaceDetailProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [localActiveWorkerId, setLocalActiveWorkerId] = useState<string | null>(null)
  const activeWorkerId =
    controlledActiveWorkerId === undefined ? localActiveWorkerId : controlledActiveWorkerId
  const setActiveWorkerId = useCallback(
    (workerId: string | null) => {
      if (onActiveWorkerChange) {
        onActiveWorkerChange(workerId)
      } else {
        setLocalActiveWorkerId(workerId)
      }
    },
    [onActiveWorkerChange]
  )
  const [composerOpen, setComposerOpen] = useState(false)
  // Mobile Team is a segmented [Orchestrator | Workers] view — each gets the full
  // height, instead of the desktop two-pane row a phone can't hold at once.
  const [mobilePane, setMobilePane] = useState<'orchestrator' | 'workers'>('orchestrator')
  const focusMode = useMobileFocusMode()
  // The strip toggle is the only way out of focus mode — if this view goes
  // away while focused (workspace deleted → Welcome pane), restore the chrome
  // so the user is never stranded without navigation.
  useEffect(() => () => setMobileFocusMode(false), [])
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const [terminalPanelHidden, setTerminalPanelHidden] = useState(false)
  const toast = useToast()
  const composer = useWorkerComposer({
    createWorker: onCreateWorker,
    open: composerOpen,
    workers,
  })
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    terminalRuns,
    autostartError: orchestratorAutostartError,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
    ...(onOrchestratorRunClosed ? { onRunClosed: onOrchestratorRunClosed } : {}),
  })
  const split = usePaneSplit()
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker, setActiveWorkerId])
  const panelTabs = useTerminalPanelTabs({
    workspaceId: workspace?.id ?? '',
    workers,
    terminalRuns,
  })
  const shellPanelTabs = panelTabs.tabs.filter((tab) => tab.kind === 'shell')
  const shellRuns = workspace
    ? terminalRuns.filter((run) => isWorkspaceShellRun(run, workspace.id))
    : []
  const { closeShellTab, openShell, shellError, shellStarting, startNewShell } =
    useWorkspaceShellLauncher({
      onCloseFailed: (message) =>
        toast.show({ kind: 'error', message: t('shellTerminal.closeFailed', { message }) }),
      ...(onShellRunClosed ? { onShellRunClosed } : {}),
      ...(onShellRunStarted ? { onShellRunStarted } : {}),
      panelTabs,
      shellRuns,
      workspaceId: workspace?.id ?? null,
    })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // Start failures no longer have a modal banner to display them — surface
  // via toast to keep parity with delete-error feedback.
  useEffect(() => {
    if (startWorkerError) toast.show({ kind: 'error', message: startWorkerError })
  }, [startWorkerError, toast])

  // Shell-start failures no longer have a dialog banner — surface via toast.
  useEffect(() => {
    if (shellError) toast.show({ kind: 'error', message: shellError })
  }, [shellError, toast])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setActiveWorkerId(null)
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStartingWorkerId(null)
    setTerminalPanelHidden(false)
    setMobilePane('orchestrator')
  }, [workspace?.id, setActiveWorkerId])

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      onTryDemo?: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (onTryDemo) welcomeProps.onTryDemo = onTryDemo
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleStopWorker = (runId: string) => {
    void onStopWorker(runId).then(({ error }) => {
      if (error) toast.show({ kind: 'error', message: error })
    })
  }

  const handleRestartWorker = (workerId: string, runId: string) => {
    setStartWorkerError(null)
    setStartingWorkerId(workerId)
    void onRestartWorker(workerId, runId)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleRenameWorker = async (
    worker: TeamListItem,
    newName: string
  ): Promise<{ error: string | null }> => {
    try {
      await renameWorker(workspace.id, worker.id, newName)
      toast.show({
        kind: 'success',
        message: t('worker.renameSuccess', { name: newName }),
      })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: t('worker.renameFailed', { message }) })
      return { error: message }
    }
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`
  const openShellTerminal = () => {
    setTerminalPanelHidden(false)
    openShell()
  }
  const startNewShellFromPanel = () => {
    setTerminalPanelHidden(false)
    startNewShell()
  }
  const orchestratorPane =
    workspace.controller_mode === 'codex_app' ? (
      <ExternalControllerPane
        key={workspace.id}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        memberCount={workers.length}
        onAddMember={() => setComposerOpen(true)}
      />
    ) : (
      <OrchestratorPane
        state={orchestrator.state}
        onRemoveWorkspace={() => {
          void onDeleteWorkspace(workspace).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            toast.show({ kind: 'error', message: `Delete failed: ${message}` })
          })
        }}
        onStart={orchestrator.start}
        onRestart={orchestrator.restart}
      />
    )

  const workersArea = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkersPane
        onAddWorkerClick={() => setComposerOpen(true)}
        onDeleteWorker={handleDeleteWorker}
        onOpenShellTerminal={openShellTerminal}
        onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
        onRenameWorker={handleRenameWorker}
        onUpdateWorkerAvatar={onUpdateWorkerAvatar}
        onStartWorker={handleStartWorker}
        onStopWorker={handleStopWorker}
        onRestartWorker={handleRestartWorker}
        startingWorkerId={startingWorkerId}
        terminalRuns={terminalRuns}
        workers={workers}
        {...(workspace.controller_mode === 'codex_app' ? {} : { workspaceId: workspace.id })}
      />
      {terminalPanelHidden ? null : (
        <TerminalBottomPanel
          tabs={shellPanelTabs}
          activeId={panelTabs.activeId}
          onSelect={panelTabs.setActive}
          onClose={(tabId) => {
            if (tabId.startsWith('shell:')) {
              closeShellTab(tabId.slice('shell:'.length))
            }
            panelTabs.closeTab(tabId)
          }}
          onClosePanel={() => setTerminalPanelHidden(true)}
          onNewShell={startNewShellFromPanel}
          newShellPending={shellStarting}
          onStartWorker={(workerId) => {
            const worker = workers.find((w) => w.id === workerId)
            if (worker) handleStartWorker(worker)
          }}
          startingWorkerId={startingWorkerId}
        />
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      {showInlineActionCenter ? (
        <ActionCenterStrip
          key={workspace.id}
          workspaceId={workspace.id}
          onOpenWorker={setActiveWorkerId}
        />
      ) : null}
      {/* Mobile: stack orchestrator over workers in a single scroll column —
          no fixed 480px min-width, no draggable splitter (a touch viewport can't
          hold a two-pane row; Parity Matrix marks resize ⚠️ fixed/折叠). Desktop
          keeps the resizable two-pane row exactly as before. */}
      {isMobile ? (
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-mobile="true"
          data-testid="workspace-detail-panes"
        >
          <div
            role="tablist"
            aria-label={t('mobile.nav.team')}
            className="flex shrink-0 items-center gap-1 border-b p-2"
            style={{ borderColor: 'var(--border)' }}
          >
            {(['orchestrator', 'workers'] as const).map((pane) => {
              const selected = mobilePane === pane
              const tabId = `mobile-team-tab-${pane}`
              const panelId = `mobile-team-panel-${pane}`
              return (
                <button
                  key={pane}
                  id={tabId}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  data-active={selected || undefined}
                  data-testid={tabId}
                  onClick={() => setMobilePane(pane)}
                  className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium"
                  style={
                    selected
                      ? { background: 'var(--accent)', color: 'var(--bg-0)' }
                      : { background: 'var(--bg-3)', color: 'var(--text-secondary)' }
                  }
                >
                  <span>
                    {pane === 'orchestrator'
                      ? workspace.controller_mode === 'codex_app'
                        ? t('controller.title')
                        : t('mobile.team.orchestrator')
                      : t('mobile.team.workers')}
                  </span>
                  {pane === 'workers' && workers.length > 0 ? (
                    <span
                      className="inline-flex items-center justify-center rounded-full min-w-[18px] h-[18px] px-1 text-[11px] font-medium tabular-nums leading-none"
                      style={
                        selected
                          ? { background: 'var(--bg-0)', color: 'var(--accent)' }
                          : { background: 'var(--bg-1)', color: 'var(--text-secondary)' }
                      }
                    >
                      {workers.length}
                    </span>
                  ) : null}
                </button>
              )
            })}
            {/* Focus toggle: collapses the shell's topbar + bottom nav so the
                terminal owns the screen. Lives in this strip (not floating over
                the terminal) and the strip stays in focus mode — it's the way
                back out. */}
            <button
              type="button"
              onClick={toggleMobileFocusMode}
              aria-pressed={focusMode}
              aria-label={focusMode ? t('mobile.focus.exit') : t('mobile.focus.enter')}
              data-testid="mobile-focus-toggle"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md"
              style={{ background: 'var(--bg-3)', color: 'var(--text-secondary)' }}
            >
              {focusMode ? (
                <Minimize2 size={16} aria-hidden />
              ) : (
                <Maximize2 size={16} aria-hidden />
              )}
            </button>
          </div>
          <div
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="mobile-team-panel"
          >
            {/* Keep both panes in full-size layout boxes. `display:none` gives
                xterm a 0px slot and then a real slot, which reads as a
                wide-to-narrow refit on phones. */}
            <div
              id="mobile-team-panel-orchestrator"
              role="tabpanel"
              aria-labelledby="mobile-team-tab-orchestrator"
              aria-hidden={mobilePane !== 'orchestrator'}
              className="mobile-team-pane flex min-h-0 min-w-0 flex-col"
              data-active={mobilePane === 'orchestrator' ? 'true' : 'false'}
            >
              {orchestratorPane}
            </div>
            <div
              id="mobile-team-panel-workers"
              role="tabpanel"
              aria-labelledby="mobile-team-tab-workers"
              aria-hidden={mobilePane !== 'workers'}
              className="mobile-team-pane flex min-h-0 min-w-0 flex-col"
              data-active={mobilePane === 'workers' ? 'true' : 'false'}
            >
              {workersArea}
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={split.containerRef}
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="workspace-detail-panes"
        >
          <div
            className="flex min-w-[480px] shrink-0 flex-col overflow-hidden"
            style={{ width: orchWidth }}
            data-testid="orchestrator-pane-shell"
          >
            {orchestratorPane}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workerPane.resize')}
            aria-valuenow={Math.round(split.orchPct * 100)}
            aria-valuemin={30}
            aria-valuemax={78}
            tabIndex={0}
            className="pane-splitter"
            style={{ left: `calc(${orchWidth} - 4px)` }}
            data-dragging={split.dragging || undefined}
            data-testid="pane-splitter"
            onPointerDown={split.beginDrag}
            onKeyDown={split.onKeyDown}
          />
          {workersArea}
        </div>
      )}
      {activeWorker ? (
        <Suspense fallback={null}>
          <WorkerModal
            onClose={() => setActiveWorkerId(null)}
            onStart={handleStartWorker}
            runId={activeWorkerRun?.run_id ?? null}
            startError={startWorkerError}
            starting={startingWorkerId === activeWorker.id}
            worker={activeWorker}
          />
        </Suspense>
      ) : null}
      {composerOpen ? (
        <Suspense fallback={null}>
          <AddWorkerDialog
            avatar={composer.avatar}
            commandPresets={composer.commandPresets}
            commandPresetId={composer.commandPresetId}
            creating={composer.creating}
            customTemplates={composer.customTemplates}
            onApplyMarketplaceImport={composer.applyMarketplaceImport}
            onAvatarChange={composer.setAvatar}
            onClose={() => setComposerOpen(false)}
            onDeleteTemplate={composer.deleteTemplate}
            onNameChange={composer.setWorkerName}
            onPresetChange={composer.setCommandPresetId}
            onRandomName={composer.randomizeWorkerName}
            onRoleDescriptionChange={composer.setRoleDescription}
            onRoleDescriptionReset={composer.resetRoleDescription}
            onRoleChange={composer.setWorkerRole}
            onSaveAsTemplate={composer.saveAsTemplate}
            onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
            onStartupCommandChange={composer.setStartupCommand}
            onTemplateChange={composer.selectTemplate}
            roleDescription={composer.roleDescription}
            roleDescriptionDefault={composer.roleDescriptionDefault}
            selectedTemplateId={composer.selectedTemplateId}
            startupCommand={composer.startupCommand}
            templateBusy={composer.templateBusy}
            workerName={composer.workerName}
            workerRole={composer.workerRole}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
