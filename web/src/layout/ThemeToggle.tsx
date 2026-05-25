import { Moon, Sun } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'

import { Tooltip } from '../ui/Tooltip.js'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'hive-theme'

const listeners = new Set<() => void>()

const getTheme = (): Theme =>
  (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'dark'

const setTheme = (theme: Theme) => {
  localStorage.setItem(STORAGE_KEY, theme)
  document.documentElement.setAttribute('data-theme', theme)
  for (const listener of listeners) listener()
}

const subscribe = (callback: () => void) => {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

export const ThemeToggle = () => {
  const theme = useSyncExternalStore(subscribe, getTheme)
  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [theme])
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode'

  return (
    <Tooltip label={label}>
      <span>
        <button
          type="button"
          aria-label={label}
          onClick={toggle}
          className="flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <Sun size={13} aria-hidden /> : <Moon size={13} aria-hidden />}
        </button>
      </span>
    </Tooltip>
  )
}
