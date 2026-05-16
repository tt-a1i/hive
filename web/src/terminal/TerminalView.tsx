import '@xterm/xterm/css/xterm.css'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useTerminalRun } from './useTerminalRun.js'

const STATUS_KEYS: Record<string, TranslationKey> = {
  connecting: 'terminal.statusConnecting',
  running: 'terminal.statusRunning',
  stopped: 'common.stopped',
}

interface TerminalViewProps {
  runId: string
  title: string
}

const candidateIds = (runId: string): string[] => [`worker-pty-${runId}`, `orch-pty-${runId}`]

/**
 * Poll the DOM for a portal slot matching this run id. We intentionally poll (vs
 * subscribing) because the slot comes and goes with Modal mount/unmount in a
 * different subtree; ref-forwarding would require every call-site to thread a
 * ref through portals. 100ms is fast enough that a user opening the Worker
 * Modal sees the xterm re-parent before the fade-in finishes.
 */
const usePortalTarget = (runId: string): HTMLElement | null => {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const ids = candidateIds(runId)
    const resolve = () => {
      for (const id of ids) {
        const node = document.getElementById(id)
        if (node) return node
      }
      return null
    }
    setTarget(resolve())
    const timer = window.setInterval(() => {
      const node = resolve()
      setTarget((current) => (current === node ? current : node))
    }, 100)
    return () => window.clearInterval(timer)
  }, [runId])
  return target
}

export const TerminalView = ({ runId, title }: TerminalViewProps) => {
  const portalTarget = usePortalTarget(runId)
  // Re-mount the inner pty view whenever the portal target changes so xterm's
  // imperative DOM follows. The server-side terminal mirror replays its
  // snapshot via the `restore` control message on reconnect, so scrollback is
  // not lost across the move.
  const mountKey = portalTarget ? portalTarget.id : 'inline'
  const body = <TerminalPtyView key={mountKey} runId={runId} title={title} />

  if (portalTarget) {
    return createPortal(body, portalTarget)
  }
  return null
}

const TerminalPtyView = ({ runId, title: _title }: TerminalViewProps) => {
  const { t } = useI18n()
  const { containerRef, error, status } = useTerminalRun(runId)
  const statusKey = STATUS_KEYS[status]
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <p className="sr-only">{statusKey ? t(statusKey) : status}</p>
      {error ? (
        <p
          role="alert"
          className="mono shrink-0 break-words px-3 py-2 text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
            borderBottom: '1px solid color-mix(in oklab, var(--status-red) 30%, transparent)',
            color: 'var(--status-red)',
          }}
        >
          {error}
        </p>
      ) : null}
      <div
        data-testid={`terminal-${runId}`}
        ref={containerRef}
        className="bg-crust h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      />
    </div>
  )
}
