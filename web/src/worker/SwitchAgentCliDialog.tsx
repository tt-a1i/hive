import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import {
  type CommandPreset,
  getAgentLaunchConfig,
  listCommandPresets,
  switchAgentCli,
} from '../api.js'
import { useI18n } from '../i18n.js'
import { WorkspaceCommandPresetSelect } from '../workspace/WorkspaceCommandPresetSelect.js'

type Props = {
  workspaceId: string
  agentId: string
  runId: string | null
  onClose: () => void
  onSaved: () => void
  onStopped: (runId: string) => void
  onStarted: (runId: string) => void
}

export const SwitchAgentCliDialog = ({
  workspaceId,
  agentId,
  runId,
  onClose,
  onSaved,
  onStopped,
  onStarted,
}: Props) => {
  const { t } = useI18n()
  const mounted = useRef(false)
  const [presets, setPresets] = useState<CommandPreset[]>([])
  const [selected, setSelected] = useState('')
  const [currentCommand, setCurrentCommand] = useState<string | null>(null)
  const [startup, setStartup] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    mounted.current = true
    let active = true
    Promise.all([listCommandPresets(), getAgentLaunchConfig(workspaceId, agentId)])
      .then(([items, config]) => {
        if (!active) return
        setPresets(items)
        setSelected(config?.command_preset_id ?? '')
        setCurrentCommand(config ? JSON.stringify([config.command, ...config.args]) : null)
      })
      .catch((e: unknown) => {
        if (active) {
          setLoadFailed(true)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [workspaceId, agentId])
  const selectedPreset = presets.find((item) => item.id === selected)
  const submit = async (restart: boolean) => {
    if (busy || loading || loadFailed || (!selectedPreset && !startup.trim())) return
    setBusy(true)
    setError(null)
    try {
      const result = await switchAgentCli(
        workspaceId,
        agentId,
        selectedPreset
          ? { command_preset_id: selectedPreset.id, restart }
          : { startup_command: startup.trim(), restart }
      )
      if (!mounted.current) return
      onSaved()
      if (runId) onStopped(runId)
      if (result.run_id) onStarted(result.run_id)
      onClose()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto w-[460px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
            data-testid="switch-cli-dialog"
          >
            <Dialog.Title className="text-lg font-semibold text-pri">
              {t('switchCli.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-sec">
              {t('switchCli.description')}
            </Dialog.Description>
            {currentCommand && (
              <div className="mt-3 text-xs text-sec">
                <span>{t('switchCli.currentCommand')}</span>
                <pre className="mt-1 whitespace-pre-wrap break-all mono">{currentCommand}</pre>
              </div>
            )}
            <div className="mt-4">
              <WorkspaceCommandPresetSelect
                presets={presets}
                value={selected}
                onChange={setSelected}
                error={null}
              />
            </div>
            {!selected && (
              <label className="mt-3 flex flex-col gap-1 text-sm text-sec">
                {t('switchCli.newCommand')}
                <input
                  className="input"
                  value={startup}
                  onChange={(event) => setStartup(event.target.value)}
                  placeholder="codex --model …"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--status-red)' }}>
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="icon-btn" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy || loading || loadFailed || (!selectedPreset && !startup.trim())}
                onClick={() => void submit(false)}
              >
                {runId ? t('switchCli.stopAndSave') : t('switchCli.save')}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={busy || loading || loadFailed || (!selectedPreset && !startup.trim())}
                onClick={() => void submit(true)}
              >
                {runId ? t('switchCli.stopSaveStart') : t('switchCli.saveAndStart')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
