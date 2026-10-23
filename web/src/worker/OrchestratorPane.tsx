import { ArrowLeftRight, Copy, Crown, LoaderCircle, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliInstallGuidancePanel } from '../workspace/CliInstallGuidance.js'
import { SwitchOrchestratorDialog } from './SwitchOrchestratorDialog.js'

/* The runtime error is `<command> CLI not found in PATH` where <command> is
   the executable name; install guidance is keyed by preset id. Only one
   built-in preset differs (cursor-agent → cursor) — keep them in sync with
   src/server/command-preset-defaults.ts. */
const CLI_COMMAND_TO_PRESET_ID: Record<string, string> = { 'cursor-agent': 'cursor' }
const CLI_NOT_FOUND_PATTERN = /^(\S+) CLI not found in PATH/u

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | {
      hasUserInputSinceStart: boolean
      kind: 'running'
      runId: string
      startupBlockedReason: 'first_run_setup' | null
    }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  onRemoveWorkspace: () => void
  onStart: () => void
  onRestart: () => void
  onSwitchCli?: (preset: CommandPreset) => Promise<void>
}

const StartingBody = () => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-starting-body" className="flex flex-1">
      <EmptyState
        icon={<LoaderCircle size={24} className="animate-spin" />}
        title={t('orchestrator.startingTitle')}
        description={t('orchestrator.startingDesc')}
      />
    </div>
  )
}

const StoppedBody = ({ onStart }: { onStart: () => void }) => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-stopped-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={24} />}
        title={t('orchestrator.stoppedTitle')}
        description={t('orchestrator.stoppedDesc')}
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> {t('orchestrator.start')}
          </button>
        }
      />
    </div>
  )
}

const FailedBody = ({
  error,
  onRemoveWorkspace,
  onRestart,
}: {
  error: string
  onRemoveWorkspace: () => void
  onRestart: () => void
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copyError = () => {
    void navigator.clipboard
      ?.writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  const notFoundCommand = CLI_NOT_FOUND_PATTERN.exec(error)?.[1]
  return (
    <div
      data-testid="orchestrator-failed-body"
      className="m-auto flex max-w-[480px] flex-col items-center gap-3 px-6 py-8"
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded text-sec"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
      >
        <Crown size={24} />
      </div>
      <div className="text-lg font-semibold text-pri">{t('orchestrator.failed')}</div>
      <div className="relative w-full">
        <pre
          data-testid="orchestrator-error-message"
          className="mono w-full max-h-40 overflow-auto whitespace-pre-wrap break-all rounded p-3 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--status-red) 24%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {error}
        </pre>
        <Tooltip label={copied ? t('common.copied') : t('common.copyError')}>
          <button
            type="button"
            onClick={copyError}
            aria-label={t('orchestrator.copyErrorAria')}
            className="icon-btn icon-btn--ghost absolute right-1 top-1 h-6 px-1.5"
            data-testid="orchestrator-copy-error"
          >
            <Copy size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      {notFoundCommand ? (
        <div className="w-full">
          <CliInstallGuidancePanel
            presetId={CLI_COMMAND_TO_PRESET_ID[notFoundCommand] ?? notFoundCommand}
            presetName={notFoundCommand}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-retry"
        >
          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
        </button>
        <button
          type="button"
          onClick={onRemoveWorkspace}
          className="icon-btn icon-btn--danger"
          data-testid="orchestrator-remove-workspace"
        >
          {t('orchestrator.removeWorkspace')}
        </button>
      </div>
      {/* Header retry was a duplicate; alias kept for back-compat. */}
      <span data-testid="orchestrator-retry-header" className="sr-only">
        {t('common.retry')}
      </span>
    </div>
  )
}

export const OrchestratorPane = ({
  state,
  onRemoveWorkspace,
  onRestart,
  onStart,
  onSwitchCli,
}: OrchestratorPaneProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [switchOpen, setSwitchOpen] = useState(false)
  return (
    <div
      className="orchestrator-pane-root relative flex h-full w-full min-w-0 flex-col"
      style={{
        background: 'var(--bg-crust)',
        ...(isMobile ? {} : { borderRight: '1px solid var(--border)' }),
      }}
      data-testid="orchestrator-terminal-slot"
    >
      {onSwitchCli ? (
        <div className="flex shrink-0 justify-end border-b border-[var(--border)] px-2 py-1">
          <button
            type="button"
            className="icon-btn icon-btn--ghost"
            disabled={state.kind === 'starting'}
            onClick={() => setSwitchOpen(true)}
          >
            <ArrowLeftRight size={12} aria-hidden /> {t('orchestrator.switchCli')}
          </button>
        </div>
      ) : null}
      {state.kind === 'running' ? (
        <div
          id={`orch-pty-${state.runId}`}
          className="orchestrator-pty-slot relative flex h-full w-full"
          data-pty-slot="orchestrator"
          data-terminal-auto-focus="true"
        >
          {isMobile ? (
            <div
              className="orchestrator-pty-placeholder pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center"
              data-testid="orchestrator-running-placeholder"
            >
              <div className="mono text-xs text-ter">{t('terminal.statusConnecting')}</div>
            </div>
          ) : null}
        </div>
      ) : state.kind === 'failed' ? (
        <FailedBody
          error={state.error}
          onRemoveWorkspace={onRemoveWorkspace}
          onRestart={onRestart}
        />
      ) : state.kind === 'stopped' ? (
        <StoppedBody onStart={onStart} />
      ) : (
        <StartingBody />
      )}
      {switchOpen && onSwitchCli ? (
        <SwitchOrchestratorDialog onClose={() => setSwitchOpen(false)} onSwitch={onSwitchCli} />
      ) : null}
    </div>
  )
}
