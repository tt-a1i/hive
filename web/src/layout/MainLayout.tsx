import type { ReactNode } from 'react'

import { Footer } from './Footer.js'
import { Topbar } from './Topbar.js'

type MainLayoutProps = {
  agentsAlive: number
  children: ReactNode
  onToggleTaskGraph: () => void
  runtimeAddress: string
  sidebar: ReactNode
  taskGraphOpen: boolean
  workspaceCount: number
}

export const MainLayout = ({
  agentsAlive,
  children,
  onToggleTaskGraph,
  runtimeAddress,
  sidebar,
  taskGraphOpen,
  workspaceCount,
}: MainLayoutProps) => (
  <div
    className="flex h-screen w-full flex-col overflow-hidden"
    style={{ background: 'var(--bg-0)', color: 'var(--text-primary)' }}
  >
    <Topbar onToggleTaskGraph={onToggleTaskGraph} taskGraphOpen={taskGraphOpen} />
    <div className="flex min-h-0 flex-1">
      <aside
        aria-label="Workspace sidebar"
        className="flex w-56 shrink-0 flex-col border-r"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      >
        {sidebar}
      </aside>
      <section className="relative flex min-w-0 flex-1">{children}</section>
    </div>
    <Footer
      agentsAlive={agentsAlive}
      connected
      runtimeAddress={runtimeAddress}
      workspaceCount={workspaceCount}
    />
  </div>
)
