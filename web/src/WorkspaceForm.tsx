import type { FormEvent } from 'react'

type WorkspaceFormProps = {
  name: string
  onNameChange: (value: string) => void
  onPathChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  path: string
}

export const WorkspaceForm = ({
  name,
  onNameChange,
  onPathChange,
  onSubmit,
  path,
}: WorkspaceFormProps) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center">
    <form
      onSubmit={onSubmit}
      className="flex w-[460px] flex-col gap-3 rounded-lg border p-6 shadow-2xl"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <h2 className="text-lg font-semibold text-pri">Create workspace</h2>
      <label className="flex flex-col gap-1 text-xs text-sec">
        Workspace Name
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="rounded border px-2 py-1.5 text-sm text-pri"
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-sec">
        Workspace Path
        <input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          className="mono rounded border px-2 py-1.5 text-sm text-pri"
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        />
      </label>
      <button
        type="submit"
        className="mt-2 rounded px-4 py-2 text-sm text-white hover:opacity-90"
        style={{ background: 'var(--accent)' }}
      >
        Create Workspace
      </button>
    </form>
  </div>
)
