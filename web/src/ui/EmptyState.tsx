import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
}

export const EmptyState = ({ title, description, icon, action }: EmptyStateProps) => (
  <div
    className="m-auto flex max-w-[360px] flex-col items-center gap-3 px-6 py-8 text-center"
    data-testid="empty-state"
  >
    {icon ? (
      <div className="text-ter" aria-hidden data-testid="empty-state-icon">
        {icon}
      </div>
    ) : null}
    <div className="text-md text-pri" data-testid="empty-state-title">
      {title}
    </div>
    <div className="text-sm text-ter" data-testid="empty-state-description">
      {description}
    </div>
    {action}
  </div>
)
