import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
}

/**
 * Empty / error state surface — used by sidebar (no workspaces),
 * workers pane (no team yet), and orchestrator (idle / failed).
 *
 * The icon plate (when icon provided) gives empty states presence — without
 * it, "absent" content reads as broken UI. Plate uses bg-2 + border + inset
 * highlight so it sits on the surface like a dimensional badge.
 */
export const EmptyState = ({ title, description, icon, action }: EmptyStateProps) => (
  <div
    className="m-auto flex max-w-[380px] flex-col items-center gap-3 px-6 py-8 text-center"
    data-testid="empty-state"
  >
    {icon ? (
      <div
        data-testid="empty-state-icon"
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-xl text-sec"
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border-bright)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 4px 12px rgba(0, 0, 0, 0.3)',
        }}
      >
        {icon}
      </div>
    ) : null}
    <div className="text-md font-medium text-pri" data-testid="empty-state-title">
      {title}
    </div>
    <div className="text-sm leading-relaxed text-ter" data-testid="empty-state-description">
      {description}
    </div>
    {action}
  </div>
)
