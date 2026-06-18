import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/globals.css'
import { App } from './app.js'
import { registerServiceWorker } from './pwa/register-service-worker.js'

const theme = localStorage.getItem('hive-theme') || 'dark'
document.documentElement.setAttribute('data-theme', theme)

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root element not found')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

void registerServiceWorker()
