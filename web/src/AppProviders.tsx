import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

import { NotificationProvider } from './notifications/NotificationProvider.js'
import { Toaster } from './ui/toast.js'
import { ToastProvider } from './ui/useToast.js'

export const AppProviders = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={250} skipDelayDuration={150}>
    <ToastProvider>
      <NotificationProvider>
        {children}
        <Toaster />
      </NotificationProvider>
    </ToastProvider>
  </RadixTooltip.Provider>
)
