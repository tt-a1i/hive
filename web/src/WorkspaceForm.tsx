import type { FormEvent } from 'react'

type WorkspaceFormProps = {
  name: string
  path: string
  onNameChange: (value: string) => void
  onPathChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export const WorkspaceForm = ({
  name,
  path,
  onNameChange,
  onPathChange,
  onSubmit,
}: WorkspaceFormProps) => (
  <form onSubmit={onSubmit}>
    <div>
      <label>
        Workspace Name
        <input value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>
    </div>
    <div>
      <label>
        Workspace Path
        <input value={path} onChange={(event) => onPathChange(event.target.value)} />
      </label>
    </div>
    <button type="submit">Create Workspace</button>
  </form>
)
