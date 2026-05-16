import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

import { I18nProvider } from './i18n.js'
import { NotificationProvider } from './notifications/NotificationProvider.js'
import { Toaster } from './ui/toast.js'
import { ToastProvider } from './ui/useToast.js'

export const AppProviders = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={250} skipDelayDuration={150}>
    <I18nProvider>
      <ToastProvider>
        <NotificationProvider>
          {children}
          <Toaster />
        </NotificationProvider>
      </ToastProvider>
    </I18nProvider>
  </RadixTooltip.Provider>
)
