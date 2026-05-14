import { Check, ChevronDown, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { CommandPreset } from '../api.js'

type WorkspaceCommandPresetSelectProps = {
  error: string | null
  onChange: (value: string) => void
  presets: CommandPreset[]
  value: string
}

/**
 * Themed dropdown for picking an Orchestrator CLI preset.
 *
 * The previous incarnation wrapped a native `<select>`, but the OS-rendered
 * pop-up menu is white on macOS and disrupts the dark dialog theme. This
 * version renders a custom listbox so the open state stays inside the design
 * system. Click-outside + Escape close the menu.
 */
export const WorkspaceCommandPresetSelect = ({
  error,
  onChange,
  presets,
  value,
}: WorkspaceCommandPresetSelectProps) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const selected = presets.find((preset) => preset.id === value)
  const commandPreview = selected
    ? [selected.command, ...selected.args].join(' ').trim()
    : 'Loading CLI presets…'
  const buttonLabel = selected?.displayName ?? 'Claude Code (CC)'
  const disabled = presets.length === 0

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-ter">
        Orchestrator CLI
      </span>
      <div ref={containerRef} className="cli-select group relative">
        <Terminal size={14} aria-hidden className="cli-select__leading" />
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-disabled={disabled || undefined}
          className="cli-select__field cli-select__field--button text-left"
          data-testid="workspace-command-preset"
          data-value={value}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {buttonLabel}
        </button>
        <ChevronDown size={14} aria-hidden className="cli-select__trailing" />
        {open && presets.length > 0 ? (
          <div
            role="listbox"
            aria-label="Orchestrator CLI options"
            className="cli-select__menu"
            data-testid="workspace-command-preset-menu"
          >
            {presets.map((preset) => {
              const isSelected = preset.id === value
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`workspace-command-preset-option-${preset.id}`}
                  className="cli-select__option"
                  onClick={() => {
                    onChange(preset.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    size={12}
                    aria-hidden
                    className="cli-select__check"
                    style={{ opacity: isSelected ? 1 : 0 }}
                  />
                  <span>{preset.displayName}</span>
                </button>
              )
            })}
          </div>
        ) : null}
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
