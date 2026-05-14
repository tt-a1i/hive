import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

type TooltipProps = {
  children: ReactNode
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}

/* Self-providing tooltip primitive — wraps its own RadixTooltip.Provider so
   the component works in any tree, including isolated test mounts that
   don't include AppProviders. Nesting providers is a no-op in Radix; the
   app-level provider still defines the global delay coordination. */
export const Tooltip = ({ children, label, side = 'top', align = 'center' }: TooltipProps) => {
  if (!label) return <>{children}</>
  return (
    <RadixTooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="tooltip" side={side} align={align} sideOffset={6}>
            {label}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  )
}
