import type { WorkspaceSummary } from '../../../src/shared/types.js'

type SidebarProps = {
  activeWorkspaceId: string | null
  onCreateClick: () => void
  onSelectWorkspace: (workspaceId: string) => void
  workspaces: WorkspaceSummary[] | null
}

export const Sidebar = ({
  activeWorkspaceId,
  onCreateClick,
  onSelectWorkspace,
  workspaces,
}: SidebarProps) => {
  return (
    <aside aria-label="Workspace sidebar">
      <div>
        <strong>Workspaces</strong>
        <button type="button" onClick={onCreateClick} aria-label="New workspace">
          +
        </button>
      </div>
      {workspaces === null ? null : workspaces.length === 0 ? (
        <p>No workspaces yet</p>
      ) : (
        <ul aria-label="Workspaces">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                aria-label={workspace.name}
                aria-current={workspace.id === activeWorkspaceId ? 'true' : undefined}
                onClick={() => onSelectWorkspace(workspace.id)}
              >
                <span>{workspace.name}</span>
                <small>{workspace.path}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
