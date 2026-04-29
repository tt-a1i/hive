import * as Dialog from '@radix-ui/react-dialog'
import { Check, UserPlus } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset } from '../api.js'
import { RoleAvatar } from './RoleAvatar.js'

type AddWorkerDialogProps = {
  commandPresets: CommandPreset[]
  commandPresetId: string
  creating?: boolean
  onClose: () => void
  onNameChange: (value: string) => void
  onPresetChange: (value: string) => void
  onRoleChange: (value: WorkerRole) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  workerName: string
  workerRole: WorkerRole
}

interface RoleCardSpec {
  value: Exclude<WorkerRole, 'custom'>
  label: string
  hint: string
}

const PRIMARY_ROLES: RoleCardSpec[] = [
  { value: 'coder', label: 'Coder', hint: 'Implements features, writes code.' },
  { value: 'reviewer', label: 'Reviewer', hint: 'Reviews code or proposals.' },
  { value: 'tester', label: 'Tester', hint: 'Writes / runs tests.' },
]

const FieldLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-[10px] font-medium uppercase tracking-wider text-ter">{children}</span>
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
    className="group flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors"
    style={{
      background: active ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))' : 'var(--bg-2)',
      borderColor: active ? 'var(--accent)' : 'var(--border)',
    }}
  >
    <div className="flex w-full items-center justify-between">
      {/* biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role */}
      <RoleAvatar role={spec.value} size={32} />
      {active ? <Check size={14} className="text-accent" aria-hidden /> : null}
    </div>
    <div className="text-sm font-medium text-pri">{spec.label}</div>
    <div className="text-[11px] leading-snug text-ter">{spec.hint}</div>
  </button>
)

const AgentRadio = ({
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
    data-testid={`agent-radio-${preset.id}`}
    className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
    style={{
      background: active ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))' : 'var(--bg-2)',
      borderColor: active ? 'var(--accent)' : 'var(--border)',
    }}
  >
    <span
      aria-hidden
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border-bright)',
        background: active ? 'var(--accent)' : 'transparent',
      }}
    >
      {active ? (
        <span className="block h-1 w-1 rounded-full" style={{ background: 'var(--bg-elevated)' }} />
      ) : null}
    </span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm text-pri">{preset.displayName}</div>
      <div className="mono truncate text-[11px] text-ter">{preset.command}</div>
    </div>
  </button>
)

export const AddWorkerDialog = ({
  commandPresets,
  commandPresetId,
  creating = false,
  onClose,
  onNameChange,
  onPresetChange,
  onRoleChange,
  onSubmit,
  workerName,
  workerRole,
}: AddWorkerDialogProps) => {
  const [showCustom, setShowCustom] = useState(workerRole === 'custom')
  const handleClose = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="add-worker-overlay"
          className="fixed inset-0 z-40"
          style={{ background: 'var(--bg-overlay)' }}
        />
        <Dialog.Content
          data-testid="add-worker-content"
          className="fixed top-1/2 left-1/2 z-50 w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border"
          style={{
            background: 'var(--bg-elevated)',
            borderColor: 'var(--border-bright)',
            boxShadow: 'var(--shadow-elev-2)',
          }}
        >
          <form onSubmit={onSubmit} aria-label="Add team member" className="flex flex-col">
            <div
              className="flex items-center gap-3 border-b px-5 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div
                className="flex h-9 w-9 items-center justify-center rounded-lg"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <UserPlus size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-md font-medium text-pri">
                  Add team member
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-ter">
                  Pick a role and a CLI agent. The orchestrator dispatches work via{' '}
                  <span className="mono">team send</span>.
                </Dialog.Description>
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              <label className="flex flex-col gap-1.5">
                <FieldLabel>Name</FieldLabel>
                <input
                  value={workerName}
                  onChange={(event) => onNameChange(event.target.value)}
                  placeholder="e.g. Alice"
                  className="rounded-md border px-3 py-2 text-sm text-pri outline-none transition-colors"
                  style={{
                    background: 'var(--bg-1)',
                    borderColor: 'var(--border-bright)',
                  }}
                />
              </label>

              <div className="flex flex-col gap-2">
                <FieldLabel>Role</FieldLabel>
                {showCustom ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustom(false)
                      onRoleChange('coder')
                    }}
                    aria-pressed
                    data-testid="role-card-custom"
                    className="flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors"
                    style={{
                      background: 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))',
                      borderColor: 'var(--accent)',
                    }}
                  >
                    <div className="flex items-center justify-between">
                      {/* biome-ignore lint/a11y/useValidAriaRole: domain prop */}
                      <RoleAvatar role="custom" size={32} />
                      <Check size={14} className="text-accent" aria-hidden />
                    </div>
                    <div className="text-sm font-medium text-pri">Custom</div>
                    <div className="text-[11px] leading-snug text-ter">
                      Same starter framework as the built-ins; describe behavior in the agent's own
                      prompt. Click to switch back.
                    </div>
                  </button>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {PRIMARY_ROLES.map((spec) => (
                      <RoleCard
                        key={spec.value}
                        active={workerRole === spec.value}
                        spec={spec}
                        onSelect={() => onRoleChange(spec.value)}
                      />
                    ))}
                  </div>
                )}
                {!showCustom ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustom(true)
                      onRoleChange('custom')
                    }}
                    data-testid="role-custom-toggle"
                    className="self-start text-[11px] text-ter hover:text-sec"
                  >
                    or use Custom →
                  </button>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <FieldLabel>Agent CLI</FieldLabel>
                {commandPresets.length === 0 ? (
                  <div className="text-[11px] text-ter">Loading presets…</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {commandPresets.map((preset) => (
                      <AgentRadio
                        key={preset.id}
                        active={commandPresetId === preset.id}
                        preset={preset}
                        onSelect={() => onPresetChange(preset.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div
              className="flex items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                onClick={onClose}
                className="icon-btn"
                data-testid="add-worker-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || !workerName.trim() || !commandPresetId}
                className="icon-btn icon-btn--primary"
                data-testid="add-worker-submit"
              >
                {creating ? 'Creating…' : 'Add member'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
