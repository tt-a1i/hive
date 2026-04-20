import type { ReactNode } from 'react'

type MainLayoutProps = {
  sidebar: ReactNode
  children: ReactNode
}

export const MainLayout = ({ sidebar, children }: MainLayoutProps) => {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface-0 text-text-primary">
      <div className="w-64 flex-shrink-0 border-r border-border bg-surface-1">{sidebar}</div>
      <div className="flex-1 flex flex-col min-w-0">{children}</div>
    </div>
  )
}
