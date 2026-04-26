import type { FormEvent } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset } from '../api.js'

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
}: AddWorkerDialogProps) => (
  <div className="fixed inset-0 z-40 flex items-center justify-center">
    <button
      type="button"
      aria-label="Close add member"
      onClick={onClose}
      className="modal-backdrop absolute inset-0"
    />
    <form
      onSubmit={onSubmit}
      className="relative flex w-[420px] flex-col gap-3 rounded-lg border p-5 shadow-2xl"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      aria-label="Add team member"
    >
      <h3 className="text-base font-semibold text-pri">Add team member</h3>
      <label className="flex flex-col gap-1 text-xs text-sec">
        Name
        <input
          value={workerName}
          onChange={(event) => onNameChange(event.target.value)}
          className="rounded border px-2 py-1.5 text-sm text-pri"
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-sec">
        Role
        <select
          value={workerRole}
          onChange={(event) => onRoleChange(event.target.value as WorkerRole)}
          className="rounded border px-2 py-1.5 text-sm text-pri"
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        >
          <option value="coder">Coder</option>
          <option value="tester">Tester</option>
          <option value="reviewer">Reviewer</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-sec">
        Agent
        <select
          value={commandPresetId}
          onChange={(event) => onPresetChange(event.target.value)}
          className="rounded border px-2 py-1.5 text-sm text-pri"
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        >
          {commandPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-sec hover:bg-3 hover:text-pri"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={creating || !workerName.trim() || !commandPresetId}
          className="rounded px-3 py-1.5 text-xs text-white hover:opacity-90"
          style={{ background: 'var(--accent)' }}
        >
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  </div>
)
