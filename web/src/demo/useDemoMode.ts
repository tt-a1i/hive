import { useState } from 'react'

export const useDemoMode = () => {
  const [demoMode, setDemoMode] = useState(false)
  return {
    demoMode,
    enableDemo: () => setDemoMode(true),
    exitDemo: () => setDemoMode(false),
  }
}
