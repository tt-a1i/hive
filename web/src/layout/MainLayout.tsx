import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'

import { Footer } from './Footer.js'
import { Topbar } from './Topbar.js'

type MainLayoutProps = {
  children: ReactNode
  onToggleTaskGraph: () => void
  running: number
  runtimeAddress: string
  sidebar: ReactNode
  stopped: number
  taskGraphOpen: boolean
  workspaceCount: number
}

export const MainLayout = ({
  children,
  onToggleTaskGraph,
  running,
  runtimeAddress,
  sidebar,
  stopped,
  taskGraphOpen,
  workspaceCount,
}: MainLayoutProps) => {
  const [workspaceSidebarCollapsed, setWorkspaceSidebarCollapsed] = useState(false)

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-0)', color: 'var(--text-primary)' }}
    >
      <Topbar onToggleTaskGraph={onToggleTaskGraph} taskGraphOpen={taskGraphOpen} />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Workspace sidebar"
          className={`relative flex shrink-0 flex-col border-r transition-[width] duration-150 ${
            workspaceSidebarCollapsed ? 'w-14' : 'w-56'
          }`}
          data-collapsed={workspaceSidebarCollapsed ? 'true' : 'false'}
          style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        >
          {workspaceSidebarCollapsed ? (
            <div className="flex h-full flex-col items-center gap-3 px-2 py-3">
              <button
                type="button"
                aria-label="Expand workspace sidebar"
                aria-expanded={false}
                className="icon-btn h-8 w-8 justify-center p-0"
                onClick={() => setWorkspaceSidebarCollapsed(false)}
              >
                <PanelLeftOpen size={16} />
              </button>
              <span className="mono rounded bg-2 px-1.5 py-1 text-[10px] text-ter">
                {workspaceCount}
              </span>
              <span className="mt-1 [writing-mode:vertical-rl] text-[10px] font-medium uppercase tracking-wider text-ter">
                Workspaces
              </span>
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-label="Collapse workspace sidebar"
                aria-expanded
                className="icon-btn absolute top-2 right-2 z-10 h-7 w-7 justify-center p-0"
                onClick={() => setWorkspaceSidebarCollapsed(true)}
              >
                <PanelLeftClose size={15} />
              </button>
              {sidebar}
            </>
          )}
        </aside>
        <section className="relative flex min-w-0 flex-1">{children}</section>
      </div>
      <Footer
        connected
        running={running}
        runtimeAddress={runtimeAddress}
        stopped={stopped}
        workspaceCount={workspaceCount}
      />
    </div>
  )
}
