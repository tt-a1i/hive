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
    <aside aria-label="Workspace sidebar" className="flex h-full flex-col">
      <div className="p-4 border-b border-border">
        <h1 className="text-xl font-bold">Hive</h1>
      </div>
      <div className="p-4 flex items-center justify-between">
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
