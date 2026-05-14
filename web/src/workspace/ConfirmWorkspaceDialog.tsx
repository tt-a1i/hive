import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Folder, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CommandPreset, FsProbeResponse } from '../api.js'
import { WorkspaceCommandPresetSelect } from './WorkspaceCommandPresetSelect.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type ConfirmWorkspaceDialogProps = {
  /** Probe result for the picked folder, or null when user chose the paste-path fallback. */
  probe: FsProbeResponse | null
  /** When true, the paste-path fallback section is expanded by default (unsupported platform). */
  pasteFallbackDefault?: boolean
  commandPresetError: string | null
  commandPresetId: string
  commandPresets: CommandPreset[]
  onCancel: () => void
  onCommandPresetChange: (value: string) => void
  onCreate: (input: WorkspaceCreateInput) => void
  onOpenServerBrowse: () => void
}

const basenameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-xs font-medium uppercase tracking-wider text-ter">{children}</span>
)

export const ConfirmWorkspaceDialog = ({
  probe,
  pasteFallbackDefault = false,
  commandPresetError,
  commandPresetId,
  commandPresets,
  onCancel,
  onCommandPresetChange,
  onCreate,
  onOpenServerBrowse,
}: ConfirmWorkspaceDialogProps) => {
  const initialPath = probe?.path ?? ''
  const initialName = probe?.suggested_name ?? basenameOf(initialPath)
  const [name, setName] = useState(initialName)
  const [pastePath, setPastePath] = useState('')
  const [pasteExpanded, setPasteExpanded] = useState(pasteFallbackDefault)
  const [startupExpanded, setStartupExpanded] = useState(false)
  const [startupCommand, setStartupCommand] = useState('')

  // Re-sync when the probe changes (user re-picks a folder without closing).
  useEffect(() => {
    setName(probe?.suggested_name ?? basenameOf(probe?.path ?? ''))
  }, [probe?.path, probe?.suggested_name])

  const pastedClean = pastePath.trim()
  const resolvedPath = pasteExpanded && pastedClean.length > 0 ? pastedClean : (probe?.path ?? '')
  const startupClean = startupCommand.trim()
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const presetsLoading = commandPresets.length === 0 && !commandPresetError
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const presetAvailabilityError = selectedPresetUnavailable
    ? `${selectedPreset.displayName} is not installed. Choose another CLI or add a custom startup command.`
    : null
  const canCreate =
    name.trim().length > 0 &&
    resolvedPath.length > 0 &&
    !presetsLoading &&
    !selectedPresetUnavailable

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      commandPresetId: commandPresetId || null,
      name: name.trim(),
      path: resolvedPath,
      ...(startupClean ? { startupCommand: startupClean } : {}),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="confirm-workspace-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="confirm-workspace-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[480px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div
              className="flex items-center gap-3 border-b px-5 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Folder size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-medium text-pri">Add workspace</Dialog.Title>
                <Dialog.Description className="text-xs text-ter">
                  Hive will load <span className="mono">.hive/tasks.md</span> and start the
                  Orchestrator here.
                </Dialog.Description>
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              <label className="flex flex-col gap-1.5">
                <FieldLabel>Path</FieldLabel>
                <input
                  readOnly
                  value={probe?.path ?? ''}
                  placeholder="(no folder picked — use paste path below)"
                  className="input input--readonly mono"
                  data-testid="confirm-workspace-path"
                />
              </label>

              {probe?.is_git_repository ? (
                <div
                  className="flex items-center gap-2 text-xs"
                  data-testid="confirm-workspace-git-badge"
                >
                  <span
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium"
                    style={{
                      background: 'color-mix(in oklab, var(--status-blue) 12%, transparent)',
                      color: 'var(--status-blue)',
                      border: '1px solid color-mix(in oklab, var(--status-blue) 30%, transparent)',
                    }}
                  >
                    <GitBranch size={11} aria-hidden />
                    {probe.current_branch ?? 'detached'}
                  </span>
                  <span className="text-ter">git repository detected</span>
                </div>
              ) : probe?.ok ? (
                <span className="text-xs text-ter">No git repository at this path.</span>
              ) : null}

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Workspace name</FieldLabel>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={basenameOf(probe?.path ?? '') || 'my-project'}
                  className="input"
                  data-testid="confirm-workspace-name"
                />
              </label>

              <WorkspaceCommandPresetSelect
                error={commandPresetError ?? presetAvailabilityError}
                onChange={onCommandPresetChange}
                presets={commandPresets}
                value={commandPresetId}
              />

              <button
                type="button"
                onClick={() => setStartupExpanded((v) => !v)}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-startup-toggle"
              >
                {startupExpanded ? (
                  <ChevronDown size={11} aria-hidden />
                ) : (
                  <ChevronRight size={11} aria-hidden />
                )}
                Advanced: custom startup command
              </button>
              {startupExpanded ? (
                <label className="flex flex-col gap-1.5">
                  <FieldLabel>Startup command</FieldLabel>
                  <input
                    type="text"
                    value={startupCommand}
                    onChange={(event) => setStartupCommand(event.target.value)}
                    placeholder="claude --resume <session-id>"
                    className="input mono"
                    data-testid="confirm-workspace-startup-command"
                  />
                  <span className="text-xs text-ter">
                    Overrides the preset for this Orchestrator. Runs in the workspace directory
                    through your login shell, so only paste commands you trust.
                  </span>
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => setPasteExpanded((v) => !v)}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-paste-toggle"
              >
                {pasteExpanded ? (
                  <ChevronDown size={11} aria-hidden />
                ) : (
                  <ChevronRight size={11} aria-hidden />
                )}
                Advanced: paste path
              </button>
              {pasteExpanded ? (
                <label className="flex flex-col gap-1.5">
                  <FieldLabel>Absolute path</FieldLabel>
                  <input
                    type="text"
                    value={pastePath}
                    onChange={(event) => setPastePath(event.target.value)}
                    placeholder="/absolute/path"
                    className="input mono"
                    data-testid="confirm-workspace-paste-path"
                  />
                </label>
              ) : null}

              <button
                type="button"
                onClick={onOpenServerBrowse}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-browse-toggle"
              >
                <ChevronRight size={11} aria-hidden />
                Advanced: browse server filesystem
              </button>
            </div>

            <div
              className="flex items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" onClick={onCancel} className="icon-btn">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!canCreate}
                data-testid="confirm-workspace-create"
                className="icon-btn icon-btn--primary"
              >
                Create workspace
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
