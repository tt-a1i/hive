import { useEffect } from 'react'

type Shortcut = {
  /** Lowercase event.key (e.g. 'b', '1'). Use a digit char '1'..'9' for index shortcuts. */
  key: string
  /** Require Cmd (mac) / Ctrl (others). */
  mod?: boolean
  /** Require Shift. */
  shift?: boolean
  /** Handler. Returning `false` lets the keystroke continue to its default
   *  action; any other return (including `undefined`) calls preventDefault. */
  handler: (event: KeyboardEvent) => boolean | undefined
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (target.isContentEditable) return true
  // xterm renders a hidden textarea that captures keystrokes; treat any
  // element inside .xterm as editable so we don't shadow shell keystrokes.
  if (target.closest('.xterm')) return true
  return false
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const hasMod = (event: KeyboardEvent): boolean => (isMac ? event.metaKey : event.ctrlKey)

/**
 * Window-level keyboard shortcuts. Skips firing when the user is typing
 * into an input/textarea/contenteditable/xterm so we never steal shell
 * keystrokes. Cmd on mac, Ctrl elsewhere.
 *
 * Example:
 *   useGlobalShortcuts([
 *     { key: 'b', mod: true, handler: () => toggleBlueprint() },
 *     { key: '1', mod: true, handler: () => switchTo(0) },
 *   ])
 */
export const useGlobalShortcuts = (shortcuts: Shortcut[]) => {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const key = event.key.toLowerCase()
      for (const shortcut of shortcuts) {
        if (key !== shortcut.key) continue
        if ((shortcut.mod ?? false) !== hasMod(event)) continue
        if ((shortcut.shift ?? false) !== event.shiftKey) continue
        const handled = shortcut.handler(event)
        if (handled !== false) event.preventDefault()
        return
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [shortcuts])
}
