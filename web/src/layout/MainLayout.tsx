import type { ReactNode } from 'react'

import type { VersionInfo } from '../api.js'
import { useI18n } from '../i18n.js'
import { Topbar } from './Topbar.js'
import {
  WORKSPACE_SIDEBAR_MAX,
  WORKSPACE_SIDEBAR_MIN,
  type WorkspaceSidebarResize,
} from './useWorkspaceSidebarResize.js'

type MainLayoutProps = {
  children: ReactNode
  hideTopbarActions?: boolean
  memoryOpen?: boolean
  onToggleMemory?: () => void
  onToggleTaskGraph?: () => void
  openTaskCount?: number
  onToggleWorkflows?: () => void
  workflowsOpen?: boolean
  sidebar: ReactNode
  sidebarResize: WorkspaceSidebarResize
  taskGraphOpen?: boolean
  topbarActions?: ReactNode
  versionInfo?: VersionInfo | null | undefined
}

export const MainLayout = ({
  children,
  hideTopbarActions = false,
  memoryOpen = false,
  onToggleMemory,
  onToggleTaskGraph,
  openTaskCount = 0,
  onToggleWorkflows,
  workflowsOpen = false,
  sidebar,
  sidebarResize,
  taskGraphOpen = false,
  topbarActions,
  versionInfo,
}: MainLayoutProps) => {
  const { t } = useI18n()

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-0)', color: 'var(--text-primary)' }}
    >
      <Topbar
        actions={topbarActions}
        hideActions={hideTopbarActions}
        memoryOpen={memoryOpen}
        {...(onToggleMemory ? { onToggleMemory } : {})}
        {...(onToggleTaskGraph ? { onToggleTaskGraph } : {})}
        openTaskCount={openTaskCount}
        taskGraphOpen={taskGraphOpen}
        {...(onToggleWorkflows ? { onToggleWorkflows } : {})}
        versionInfo={versionInfo}
        workflowsOpen={workflowsOpen}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside
          aria-label={t('layout.sidebarAria')}
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
            aria-label={t('layout.sidebarResizeAria')}
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
        <section className="relative flex min-w-0 flex-1 overflow-hidden">{children}</section>
      </div>
    </div>
  )
}
