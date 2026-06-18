import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'

type DragHandleProps = {
  onPointerDown?: ((e: React.PointerEvent) => void) | undefined
  'data-drag-handle'?: boolean | undefined
}

type CollapsiblePanelProps = {
  id: string
  title: string
  icon?: ReactNode | undefined
  children: ReactNode
  collapsed: boolean
  onToggle: () => void
  dragHandleProps?: DragHandleProps | undefined
  rightSlot?: ReactNode | undefined
}

export const CollapsiblePanel = ({
  id,
  title,
  icon,
  children,
  collapsed,
  onToggle,
  dragHandleProps,
  rightSlot,
}: CollapsiblePanelProps) => {
  return (
    <section className="collapsible-panel" data-panel-id={id} data-collapsed={collapsed || undefined}>
      <header
        className="collapsible-panel__header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        aria-expanded={!collapsed}
        aria-controls={`panel-content-${id}`}
      >
        <span
          className="collapsible-panel__drag"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          {...dragHandleProps}
        >
          <GripVertical size={12} aria-hidden />
        </span>
        {icon ? <span className="collapsible-panel__icon">{icon}</span> : null}
        <span className="collapsible-panel__title">{title}</span>
        {rightSlot ? <span className="collapsible-panel__summary">{rightSlot}</span> : null}
        <span className="collapsible-panel__toggle" aria-hidden>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </header>
      <div
        id={`panel-content-${id}`}
        className="collapsible-panel__content"
        aria-hidden={collapsed}
      >
        {children}
      </div>
    </section>
  )
}
