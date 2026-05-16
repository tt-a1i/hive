import { useCallback, useRef } from 'react'

export const useWorkerHighlight = () => {
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  return useCallback((workerName: string) => {
    if (typeof document === 'undefined') return
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(workerName)
        : workerName.replace(/"/g, '\\"')
    const target = document.querySelector<HTMLElement>(`[data-worker-name="${escaped}"]`)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    target.classList.add('worker-card-shell--highlight')
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
    highlightTimeoutRef.current = setTimeout(() => {
      target.classList.remove('worker-card-shell--highlight')
      highlightTimeoutRef.current = null
    }, 1000)
  }, [])
}
