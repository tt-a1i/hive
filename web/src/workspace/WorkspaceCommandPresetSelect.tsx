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
    : 'Loading CLI presets...'

  return (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-ter">
      Orchestrator CLI
      <select
        className="rounded border px-2 py-1.5 text-sm text-pri"
        data-testid="workspace-command-preset"
        disabled={presets.length === 0}
        onChange={(event) => onChange(event.target.value)}
        style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
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
      <span className="mono truncate text-[11px] normal-case tracking-normal text-ter">
        {commandPreview}
      </span>
      {error ? (
        <span
          className="text-[11px] normal-case tracking-normal"
          style={{ color: 'var(--status-red)' }}
        >
          {error}
        </span>
      ) : null}
    </label>
  )
}
