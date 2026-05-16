import { Check, ChevronDown, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset } from '../api.js'
import { RoleAvatar } from './RoleAvatar.js'

interface RoleCardSpec {
  value: WorkerRole
  label: string
  dashed?: boolean
}

const ROLE_CARDS: RoleCardSpec[] = [
  { value: 'coder', label: 'Coder' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'tester', label: 'Tester' },
  { value: 'custom', label: 'Custom', dashed: true },
]

const ROLE_LABELS: Record<WorkerRole, string> = {
  coder: 'Coder',
  custom: 'Custom',
  reviewer: 'Reviewer',
  tester: 'Tester',
}

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-sm font-medium text-sec">{children}</span>
)

const RoleCard = ({
  active,
  spec,
  onSelect,
}: {
  active: boolean
  spec: RoleCardSpec
  onSelect: () => void
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={active}
    data-testid={`role-card-${spec.value}`}
    className={`selectable-card${spec.dashed ? ' selectable-card--dashed' : ''} flex items-center gap-3 px-3 py-2`}
  >
    <RoleAvatar role={spec.value} size={20} />
    <span className="flex-1 text-left text-base font-medium text-pri">{spec.label}</span>
    {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
  </button>
)

export const RolePicker = ({
  onRoleChange,
  workerRole,
}: {
  onRoleChange: (value: WorkerRole) => void
  workerRole: WorkerRole
}) => (
  <div className="flex flex-col gap-2">
    <SectionLabel>Role</SectionLabel>
    <div className="grid grid-cols-2 gap-2">
      {ROLE_CARDS.map((spec) => (
        <RoleCard
          key={spec.value}
          active={workerRole === spec.value}
          spec={spec}
          onSelect={() => onRoleChange(spec.value)}
        />
      ))}
    </div>
  </div>
)

export const RoleInstructionsField = ({
  modified,
  onChange,
  onReset,
  roleDescription,
  workerRole,
}: {
  modified: boolean
  onChange: (value: string) => void
  onReset: () => void
  roleDescription: string
  workerRole: WorkerRole
}) => {
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  useEffect(() => {
    if (workerRole === 'custom' || modified) setInstructionsOpen(true)
  }, [modified, workerRole])

  return (
    <details
      open={instructionsOpen}
      onToggle={(event) => setInstructionsOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="group flex flex-col gap-2"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 list-none">
        <span className="flex items-center gap-1.5">
          <ChevronDown
            size={12}
            aria-hidden
            className="-rotate-90 text-ter transition-transform duration-150 group-open:rotate-0"
          />
          <SectionLabel>Role instructions</SectionLabel>
          {modified ? (
            <span className="text-sm text-ter">
              · Modified from {ROLE_LABELS[workerRole]} default
            </span>
          ) : null}
        </span>
        {modified ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onReset()
            }}
          >
            <RotateCcw size={12} aria-hidden />
            Reset
          </button>
        ) : null}
      </summary>
      <textarea
        aria-label="Role instructions"
        id="add-worker-role-instructions"
        value={roleDescription}
        rows={5}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={
          workerRole === 'custom'
            ? 'You are a security reviewer focused on auth and input validation. Use team report to hand findings back to the orchestrator.'
            : undefined
        }
        title="Injected into the agent's startup prompt and every dispatch. Hive's team protocol stays fixed; this only steers role behavior."
        className="input mono resize-y text-sm"
        style={{ minHeight: 150 }}
        data-testid="role-instructions-textarea"
      />
    </details>
  )
}

const AgentChip = ({
  active,
  preset,
  onSelect,
}: {
  active: boolean
  preset: CommandPreset
  onSelect: () => void
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={active}
    disabled={preset.available === false}
    data-testid={`agent-radio-${preset.id}`}
    className="selectable-card flex items-center justify-between gap-2 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-45"
  >
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="truncate text-base font-medium text-pri">{preset.displayName}</span>
      <span className="mono truncate text-xs text-ter">
        {preset.command}
        {preset.available === false ? ' · not found' : ''}
      </span>
    </span>
    {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
  </button>
)

export const AgentCliPicker = ({
  commandPresetId,
  commandPresets,
  onPresetChange,
}: {
  commandPresetId: string
  commandPresets: CommandPreset[]
  onPresetChange: (value: string) => void
}) => (
  <div className="flex flex-col gap-2">
    <SectionLabel>Agent CLI</SectionLabel>
    {commandPresets.length === 0 ? (
      <div className="text-sm text-ter">Loading presets…</div>
    ) : (
      <div className="grid grid-cols-2 gap-2">
        {commandPresets.map((preset) => (
          <AgentChip
            key={preset.id}
            active={commandPresetId === preset.id}
            preset={preset}
            onSelect={() => onPresetChange(preset.id)}
          />
        ))}
      </div>
    )}
  </div>
)

export const StartupCommandField = ({
  onChange,
  value,
}: {
  onChange: (value: string) => void
  value: string
}) => {
  const clean = value.trim()
  return (
    <details className="group flex flex-col gap-2">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 list-none">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronDown
            size={12}
            aria-hidden
            className="-rotate-90 shrink-0 text-ter transition-transform duration-150 group-open:rotate-0"
          />
          <SectionLabel>Startup command</SectionLabel>
          {clean ? <span className="truncate text-sm text-ter">· overrides CLI launch</span> : null}
        </span>
      </summary>
      <div
        className="flex flex-col gap-2 rounded border bg-2 p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <input
          aria-label="Startup command"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="qwen --model qwen3-coder"
          className="input mono text-sm"
          spellCheck={false}
        />
        <p className="text-sm leading-5 text-ter">
          Optional. Runs through your login shell in this workspace. Use it for custom agents or
          native resume commands such as{' '}
          <span className="mono">claude --resume &lt;session-id&gt;</span>.
        </p>
      </div>
    </details>
  )
}
