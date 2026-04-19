import type { WorkspaceSummary } from '../../src/shared/types.js'

type WorkspaceListProps = {
  workspaces: WorkspaceSummary[] | null
  onSelect: (workspaceId: string) => void
}

export const WorkspaceList = ({ workspaces, onSelect }: WorkspaceListProps) => {
  if (workspaces === null) {
    return null
  }

  if (workspaces.length === 0) {
    return <p>No workspaces yet</p>
  }

  return (
    <ul aria-label="Workspaces">
      {workspaces.map((workspace) => (
        <li key={workspace.id}>
          <button type="button" onClick={() => onSelect(workspace.id)}>
            {workspace.name}
          </button>
        </li>
      ))}
    </ul>
  )
}
