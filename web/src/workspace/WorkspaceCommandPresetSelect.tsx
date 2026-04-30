import { ChevronDown, Terminal } from 'lucide-react'

import type { CommandPreset } from '../api.js'

type WorkspaceCommandPresetSelectProps = {
  error: string | null
  onChange: (value: string) => void
  presets: CommandPreset[]
  value: string
}

export const WorkspaceCommandPresetSelect = ({
  error,
  onChange,
  presets,
  value,
}: WorkspaceCommandPresetSelectProps) => {
  const selected = presets.find((preset) => preset.id === value)
  const commandPreview = selected
    ? [selected.command, ...selected.args].join(' ').trim()
    : 'Loading CLI presets…'

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-ter">
        Orchestrator CLI
      </span>
      <div className="cli-select group">
        <Terminal size={14} aria-hidden className="cli-select__leading" />
        <select
          className="cli-select__field"
          data-testid="workspace-command-preset"
          disabled={presets.length === 0}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          {presets.length === 0 ? (
            <option value={value}>Claude Code (CC)</option>
          ) : (
            presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.displayName}
              </option>
            ))
          )}
        </select>
        <ChevronDown size={14} aria-hidden className="cli-select__trailing" />
      </div>
      <div
        className="mono flex items-center gap-1.5 truncate text-[11px] text-ter"
        title={commandPreview}
      >
        <span className="text-sec">$</span>
        <span className="truncate">{commandPreview}</span>
      </div>
      {error ? (
        <span className="text-[11px]" style={{ color: 'var(--status-red)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
