import type { ReactNode } from 'react'

import { Topbar } from './Topbar.js'
import {
  useWorkspaceSidebarResize,
  WORKSPACE_SIDEBAR_MAX,
  WORKSPACE_SIDEBAR_MIN,
} from './useWorkspaceSidebarResize.js'

type MainLayoutProps = {
  children: ReactNode
  hideTopbarActions?: boolean
  onToggleTaskGraph: () => void
  openTaskCount?: number
  sidebar: ReactNode
  taskGraphOpen: boolean
}

export const MainLayout = ({
  children,
  hideTopbarActions = false,
  onToggleTaskGraph,
  openTaskCount = 0,
  sidebar,
  taskGraphOpen,
}: MainLayoutProps) => {
  const sidebarResize = useWorkspaceSidebarResize()

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-0)', color: 'var(--text-primary)' }}
    >
      <Topbar
        hideActions={hideTopbarActions}
        onToggleTaskGraph={onToggleTaskGraph}
        openTaskCount={openTaskCount}
        taskGraphOpen={taskGraphOpen}
      />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Workspace sidebar"
          className="workspace-sidebar relative flex shrink-0 flex-col"
          data-resizing={sidebarResize.resizing ? 'true' : 'false'}
          style={{
            background: 'var(--bg-0)',
            boxShadow: 'inset -1px 0 0 var(--border)',
            width: `${sidebarResize.width}px`,
          }}
        >
          {sidebar}
          <hr
            aria-label="Resize workspace sidebar"
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN}
            aria-valuemax={WORKSPACE_SIDEBAR_MAX}
            aria-valuenow={Math.round(sidebarResize.width)}
            tabIndex={0}
            className="workspace-sidebar-resizer"
            data-resizing={sidebarResize.resizing ? 'true' : 'false'}
            onMouseDown={sidebarResize.beginResize}
            onKeyDown={sidebarResize.onResizeKeyDown}
          />
        </aside>
        <section className="relative flex min-w-0 flex-1">{children}</section>
      </div>
    </div>
  )
}
