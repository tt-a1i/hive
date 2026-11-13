import { Check, ChevronDown, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'

const CLI_ICON_MAP: Record<string, string> = {
  claude: '/cli-icons/claude.png',
  codex: '/cli-icons/codex.png',
  opencode: '/cli-icons/opencode.svg',
  gemini: '/cli-icons/gemini.png',
  hermes: '/cli-icons/hermes.png',
  qwen: '/cli-icons/qwen.png',
  pi: '/cli-icons/pi.svg',
  agy: '/cli-icons/agy.png',
  cursor: '/cli-icons/cursor.ico',
  grok: '/cli-icons/grok.ico',
}

/**
 * Renders a preset logo with an error fallback to Lucide Terminal.
 * For opencode, adds a light background for high contrast in dark mode (spec §6.3).
 */
const PresetIcon = ({ id, className }: { id: string; className?: string }) => {
  const [error, setError] = useState(false)
  const logoSrc = CLI_ICON_MAP[id]
  if (logoSrc && !error) {
    return (
      <img
        src={logoSrc}
        alt=""
        onError={() => setError(true)}
        className={`${className} object-contain rounded-xs ${id === 'opencode' ? 'bg-[#ebebeb] p-[1px]' : ''}`}
      />
    )
  }
  return <Terminal size={14} className={className} />
}

type WorkspaceCommandPresetSelectProps = {
  error: string | null
  label?: string
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
  label,
  onChange,
  presets,
  value,
}: WorkspaceCommandPresetSelectProps) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const selected = presets.find((preset) => preset.id === value)
  const genericSelected = value === ''
  const commandPreview = selected
    ? [selected.command, ...selected.args].join(' ').trim()
    : genericSelected
      ? t('workspace.preset.genericPreview')
      : t('workspace.preset.loading')
  const buttonLabel =
    selected?.displayName ?? (genericSelected ? t('workspace.preset.generic') : 'Claude Code (CC)')
  const disabled = presets.length === 0 && !genericSelected

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
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-ter">
        {label ?? t('workspace.preset.label')}
      </span>
      <div ref={containerRef} className="cli-select group relative">
        <PresetIcon id={value} className="cli-select__leading w-3.5 h-3.5" />
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
            aria-label={t('workspace.preset.optionsAria')}
            className="cli-select__menu"
            data-testid="workspace-command-preset-menu"
          >
            {presets.map((preset) => {
              const isSelected = preset.id === value
              const isUnavailable = preset.available === false
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
                  <PresetIcon id={preset.id} className="w-3.5 h-3.5 text-ter shrink-0" />
                  <span>
                    {preset.displayName}
                    {isUnavailable ? t('workspace.preset.notFoundSuffix') : ''}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              role="option"
              aria-selected={genericSelected}
              data-testid="workspace-command-preset-option-generic"
              className="cli-select__option"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            >
              <Check
                size={12}
                aria-hidden
                className="cli-select__check"
                style={{ opacity: genericSelected ? 1 : 0 }}
              />
              <Terminal size={14} className="text-ter shrink-0" />
              <span>{t('workspace.preset.generic')}</span>
            </button>
          </div>
        ) : null}
      </div>
      <div
        className="mono flex items-center gap-1.5 truncate text-xs text-ter"
        title={commandPreview}
      >
        <span className="text-sec">$</span>
        <span className="truncate">{commandPreview}</span>
      </div>
      {error ? (
        <span className="text-xs" style={{ color: 'var(--status-red)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
