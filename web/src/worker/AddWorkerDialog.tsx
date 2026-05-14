import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronDown, Dices, Info, RotateCcw } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

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
  onRandomName: () => void
  onRoleDescriptionChange: (value: string) => void
  onRoleDescriptionReset: () => void
  onRoleChange: (value: WorkerRole) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  roleDescription: string
  roleDescriptionDefault: string
  workerName: string
  workerRole: WorkerRole
}

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
    className={`selectable-card${spec.dashed ? ' selectable-card--dashed' : ''} flex items-center gap-2.5 px-3 py-2.5`}
  >
    <RoleAvatar role={spec.value} size={20} />
    <span className="flex-1 text-left text-base font-medium text-pri">{spec.label}</span>
    {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
  </button>
)

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
    data-testid={`agent-radio-${preset.id}`}
    className="selectable-card flex items-center justify-between gap-2 px-3 py-2.5"
  >
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="truncate text-base font-medium text-pri">{preset.displayName}</span>
      <span className="mono truncate text-xs text-ter">{preset.command}</span>
    </span>
    {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
  </button>
)

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm font-medium text-sec">{children}</span>
)

export const AddWorkerDialog = ({
  commandPresets,
  commandPresetId,
  creating = false,
  onClose,
  onNameChange,
  onPresetChange,
  onRandomName,
  onRoleDescriptionChange,
  onRoleDescriptionReset,
  onRoleChange,
  onSubmit,
  roleDescription,
  roleDescriptionDefault,
  workerName,
  workerRole,
}: AddWorkerDialogProps) => {
  const handleClose = (open: boolean) => {
    if (!open) onClose()
  }
  const roleDescriptionModified = roleDescription !== roleDescriptionDefault
  const roleLabel = ROLE_LABELS[workerRole]
  // Instructions textarea hides behind a disclosure so the dialog stops feeling
  // like a prompt editor on first open. It auto-expands when the user picks
  // Custom (no default prompt to seed) or when they have already started
  // editing — but we only force it *open*, never closed, so users keep control.
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const shouldAutoExpandInstructions = workerRole === 'custom' || roleDescriptionModified
  useEffect(() => {
    if (shouldAutoExpandInstructions) setInstructionsOpen(true)
  }, [shouldAutoExpandInstructions])

  // Surface why Submit is disabled — silent grey-out is the worst kind of
  // form friction, especially after we hide the textarea behind a disclosure.
  const submitBlockedReason: string | null = !workerName.trim()
    ? 'Enter a name'
    : !commandPresetId
      ? 'Pick a CLI agent'
      : !roleDescription.trim()
        ? 'Add role instructions'
        : null

  return (
    <Dialog.Root open onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="add-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="add-worker-content"
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[560px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <form onSubmit={onSubmit} aria-label="Add team member" className="flex flex-col">
              <div
                className="flex shrink-0 flex-col gap-0.5 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <Dialog.Title className="text-lg font-medium text-pri">
                  Add team member
                </Dialog.Title>
                <Dialog.Description className="text-sm text-ter">
                  Pick a role and a CLI agent. The orchestrator dispatches work via{' '}
                  <span className="mono">team send</span>.
                </Dialog.Description>
              </div>

              <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <SectionLabel>Name</SectionLabel>
                    <button
                      type="button"
                      aria-label="Generate random member name"
                      title="Generate random member name"
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
                      onClick={onRandomName}
                      data-testid="random-worker-name"
                    >
                      <Dices size={12} aria-hidden />
                      Random
                    </button>
                  </div>
                  <input
                    // biome-ignore lint/a11y/noAutofocus: dialog is opt-in; without this Radix parks focus on the first toolbar button (Random) rather than the name field
                    autoFocus
                    value={workerName}
                    onChange={(event) => onNameChange(event.target.value)}
                    placeholder="e.g. Alice"
                    className="input"
                  />
                </label>

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

                <details
                  open={instructionsOpen}
                  onToggle={(event) =>
                    setInstructionsOpen((event.currentTarget as HTMLDetailsElement).open)
                  }
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
                      {roleDescriptionModified ? (
                        <span className="text-sm text-ter">
                          · Modified from {roleLabel} default
                        </span>
                      ) : null}
                    </span>
                    {roleDescriptionModified ? (
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onRoleDescriptionReset()
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
                    onChange={(event) => onRoleDescriptionChange(event.currentTarget.value)}
                    placeholder={
                      workerRole === 'custom'
                        ? 'You are a security reviewer focused on auth and input validation. Use team report to hand findings back to the orchestrator.'
                        : undefined
                    }
                    title="Injected into the agent's startup prompt and every dispatch. Hive's team protocol stays fixed; this only steers role behavior."
                    className="input mono resize-y"
                    style={{ minHeight: 150, fontSize: 12 }}
                    data-testid="role-instructions-textarea"
                  />
                </details>

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
              </div>

              <div
                className="flex shrink-0 items-center gap-3 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <span
                  className="flex items-center gap-1.5 text-sm text-ter"
                  data-testid="add-worker-submit-hint"
                >
                  {submitBlockedReason && !creating ? (
                    <>
                      <Info size={12} aria-hidden />
                      {submitBlockedReason}
                    </>
                  ) : null}
                </span>
                <div className="flex-1" />
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
                  disabled={creating || submitBlockedReason !== null}
                  className="icon-btn icon-btn--primary"
                  data-testid="add-worker-submit"
                >
                  {creating ? 'Creating…' : 'Add member'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
