import * as Dialog from '@radix-ui/react-dialog'
import { Check, Dices, RotateCcw, UserPlus } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'

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
  hint: string
  dashed?: boolean
}

const ROLE_CARDS: RoleCardSpec[] = [
  { value: 'coder', label: 'Coder', hint: 'Implements features.' },
  { value: 'reviewer', label: 'Reviewer', hint: 'Reviews code.' },
  { value: 'tester', label: 'Tester', hint: 'Writes / runs tests.' },
  { value: 'custom', label: 'Custom', hint: 'Describe behavior freely.', dashed: true },
]

const ROLE_LABELS: Record<WorkerRole, string> = {
  coder: 'Coder',
  custom: 'Custom',
  reviewer: 'Reviewer',
  tester: 'Tester',
}

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
    className="group flex flex-col items-start gap-2 rounded-lg p-3 text-left transition-colors"
    style={{
      background: active ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))' : 'var(--bg-2)',
      border: active
        ? '1px solid var(--accent)'
        : spec.dashed
          ? '1px dashed var(--border-bright)'
          : '1px solid var(--border)',
    }}
  >
    <div className="flex w-full items-center justify-between">
      <RoleAvatar role={spec.value} size={28} />
      {active ? <Check size={14} className="text-accent" aria-hidden /> : null}
    </div>
    <div className="text-sm font-medium text-pri">{spec.label}</div>
    <div className="text-[11px] leading-snug text-ter">{spec.hint}</div>
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
    className="flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors"
    style={{
      background: active ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))' : 'var(--bg-2)',
      borderColor: active ? 'var(--accent)' : 'var(--border)',
    }}
  >
    <span className="truncate text-[12px] font-medium text-pri">{preset.displayName}</span>
    <span className="mono truncate text-[10px] text-ter">{preset.command}</span>
  </button>
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
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[720px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
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

              <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel>Name</FieldLabel>
                    <button
                      type="button"
                      aria-label="Generate random member name"
                      title="Generate random member name"
                      className="icon-btn h-7 px-2 text-[11px]"
                      onClick={onRandomName}
                      data-testid="random-worker-name"
                    >
                      <Dices size={13} aria-hidden />
                      Random
                    </button>
                  </div>
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
                  <div className="grid grid-cols-4 gap-2">
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

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="add-worker-role-instructions">
                      <FieldLabel>Role instructions</FieldLabel>
                    </label>
                    <div className="flex shrink-0 items-center gap-2">
                      {roleDescriptionModified ? (
                        <span className="text-[11px] text-ter">
                          Modified from {roleLabel} default
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn h-7 px-2 text-[11px]"
                        disabled={!roleDescriptionModified}
                        onClick={onRoleDescriptionReset}
                      >
                        <RotateCcw size={12} aria-hidden />
                        Reset
                      </button>
                    </div>
                  </div>
                  <textarea
                    aria-label="Role instructions"
                    id="add-worker-role-instructions"
                    value={roleDescription}
                    rows={5}
                    onChange={(event) => onRoleDescriptionChange(event.currentTarget.value)}
                    title="Injected into the agent's startup prompt and every dispatch. Hive's team protocol stays fixed; this only steers role behavior."
                    className="mono min-h-[118px] resize-y rounded-md border px-3 py-2 text-[12px] leading-relaxed text-pri outline-none transition-colors focus:border-[var(--accent)]"
                    style={{
                      background: 'var(--bg-1)',
                      borderColor: 'var(--border-bright)',
                    }}
                  />
                  <details className="group rounded-md border px-3 py-2 text-[11px]">
                    <summary className="cursor-pointer select-none text-ter transition-colors group-open:text-sec">
                      Preview injected prompt
                    </summary>
                    <pre
                      data-testid="role-instructions-preview"
                      className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border px-3 py-2 text-[11px] leading-relaxed text-sec"
                      style={{
                        background: 'var(--bg-0)',
                        borderColor: 'var(--border)',
                      }}
                    >
                      {`[Hive prompt excerpt]
你的角色：
${roleDescription}

任务内容：
<orchestrator task>`}
                    </pre>
                  </details>
                </div>

                <div className="flex flex-col gap-2">
                  <FieldLabel>Agent CLI</FieldLabel>
                  {commandPresets.length === 0 ? (
                    <div className="text-[11px] text-ter">Loading presets…</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                  disabled={
                    creating || !workerName.trim() || !commandPresetId || !roleDescription.trim()
                  }
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
