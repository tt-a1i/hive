import { LoaderCircle, Play, Plus, Terminal as TerminalIcon } from 'lucide-react'

import { useI18n } from '../i18n.js'
import { TerminalTabs } from './TerminalTabs.js'
import { TERMINAL_PANEL_MIN_HEIGHT, useTerminalPanelHeight } from './useTerminalPanelHeight.js'
import type { TerminalTab } from './useTerminalPanelTabs.js'

type TerminalBottomPanelProps = {
  tabs: readonly TerminalTab[]
  activeId: string | null
  scopeKey?: string | undefined
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onClosePanel: () => void
  onNewShell: () => void
  newShellPending: boolean
  onStartWorker: (workerId: string) => void
  startingWorkerId: string | null
}

const findTab = (tabs: readonly TerminalTab[], id: string | null): TerminalTab | null => {
  if (!id) return null
  return tabs.find((tab) => tab.id === id) ?? null
}

/**
 * Bottom-docked terminal panel. Renders one portal slot div for the active
 * tab's PTY (worker-pty-${runId} / shell-pty-${runId}). The xterm itself is
 * mounted by WorkspaceTerminalPanels at app root and re-parents into the
 * visible slot via the existing TerminalView portal indirection — so
 * switching tabs is "DOM slot toggle", not "xterm re-init".
 */
export const TerminalBottomPanel = ({
  tabs,
  activeId,
  onSelect,
  onClose,
  onClosePanel,
  onNewShell,
  newShellPending,
  onStartWorker,
  startingWorkerId,
}: TerminalBottomPanelProps) => {
  const { t } = useI18n()
  const resize = useTerminalPanelHeight()
  if (tabs.length === 0) {
    return (
      <div
        data-testid="terminal-bottom-panel"
        className="relative flex shrink-0 flex-col items-center justify-center gap-3 text-center text-xs text-ter"
        style={{
          height: resize.height,
          background: 'var(--bg-1)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <TerminalIcon size={16} aria-hidden />
        <button
          type="button"
          onClick={onNewShell}
          disabled={newShellPending}
          className="icon-btn icon-btn--primary"
          data-testid="terminal-empty-new-shell"
        >
          {newShellPending ? (
            <LoaderCircle size={12} className="animate-spin" aria-hidden />
          ) : (
            <Plus size={12} aria-hidden />
          )}
          {t('terminalPanel.newShell')}
        </button>
      </div>
    )
  }
  const active = findTab(tabs, activeId) ?? tabs[0] ?? null
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: panel container hosts a Cmd+W keyboard shortcut for closing the active terminal tab
    <div
      data-testid="terminal-bottom-panel"
      className="relative flex shrink-0 flex-col"
      style={{
        height: resize.height,
        background: 'var(--bg-1)',
        borderTop: '1px solid var(--border)',
      }}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'w' &&
          activeId
        ) {
          event.preventDefault()
          onClose(activeId)
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: separator role on a div is the canonical resize handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminalPanel.resizeAria')}
        aria-valuemin={TERMINAL_PANEL_MIN_HEIGHT}
        aria-valuenow={Math.round(resize.height)}
        className="absolute top-0 right-0 left-0 z-10 h-2 -translate-y-1 cursor-ns-resize"
        tabIndex={-1}
        data-resizing={resize.dragging || undefined}
        data-testid="terminal-panel-resize-handle"
        onPointerDown={resize.beginDrag}
      />
      <TerminalTabs
        tabs={tabs}
        activeId={active?.id ?? null}
        onSelect={onSelect}
        onClose={onClose}
        onClosePanel={onClosePanel}
        onNewShell={onNewShell}
        newShellPending={newShellPending}
      />
      <div className="min-h-0 flex-1" style={{ background: 'var(--bg-crust)' }}>
        {active ? (
          <ActiveTabBody
            tab={active}
            onStartWorker={onStartWorker}
            startingWorkerId={startingWorkerId}
          />
        ) : null}
      </div>
    </div>
  )
}

type ActiveTabBodyProps = {
  tab: TerminalTab
  onStartWorker: (workerId: string) => void
  startingWorkerId: string | null
}

const ActiveTabBody = ({ tab, onStartWorker, startingWorkerId }: ActiveTabBodyProps) => {
  const { t } = useI18n()
  if (tab.kind === 'worker') {
    if (!tab.runId) {
      const starting = startingWorkerId === tab.workerId
      return (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-ter"
          data-testid="terminal-panel-stopped-worker"
        >
          <span className="flex items-center gap-2">
            <TerminalIcon size={14} aria-hidden />
            {t('terminalPanel.workerStopped', { name: tab.label })}
          </span>
          <button
            type="button"
            onClick={() => onStartWorker(tab.workerId)}
            disabled={starting}
            className="icon-btn icon-btn--primary"
            data-testid="terminal-panel-start-worker"
          >
            {starting ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <Play size={12} aria-hidden />
            )}
            {starting ? t('common.starting') : t('common.start')}
          </button>
        </div>
      )
    }
    return (
      <div
        id={`worker-pty-${tab.runId}`}
        className="flex h-full w-full"
        data-pty-slot="worker"
        data-testid={`terminal-panel-slot-worker-${tab.workerId}`}
      />
    )
  }
  return (
    <div
      id={`shell-pty-${tab.runId}`}
      className="flex h-full w-full"
      data-pty-slot="shell"
      data-testid={`terminal-panel-slot-shell-${tab.runId}`}
    />
  )
}
