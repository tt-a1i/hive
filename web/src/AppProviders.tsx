import type { ReactNode } from 'react'

import { NotificationProvider } from './notifications/NotificationProvider.js'
import { Toaster } from './ui/toast.js'
import { ToastProvider } from './ui/useToast.js'

export const AppProviders = ({ children }: { children: ReactNode }) => (
  <ToastProvider>
    <NotificationProvider>
      {children}
      <Toaster />
    </NotificationProvider>
  </ToastProvider>
)
