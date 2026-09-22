import '@xterm/xterm/css/xterm.css'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { createTerminalVisibleResizeEvent } from './terminal-resize-events.js'
import { useTerminalRun } from './useTerminalRun.js'
import type { TerminalWheelInputProfile } from './wheelFallback.js'

const STATUS_KEYS: Record<string, TranslationKey> = {
  connecting: 'terminal.statusConnecting',
  running: 'terminal.statusRunning',
  stopped: 'common.stopped',
}

interface TerminalViewProps {
  inputProfile?: TerminalWheelInputProfile
  onRunExited?: (runId: string) => void
  runId: string
  startupBlockedReason?: 'first_run_setup' | null
  title: string
}

const TERMINAL_PARKING_LOT_ID = 'hive-terminal-parking-lot'
const PARKED_TERMINAL_DISPOSE_DELAY_MS = 500

const candidateIds = (runId: string): string[] => [
  `worker-pty-${runId}`,
  `orch-pty-${runId}`,
  `shell-pty-${runId}`,
]

const isHiddenTerminalSlot = (node: HTMLElement): boolean => {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return true
    if (current.classList.contains('hidden')) return true
    const style = window.getComputedStyle?.(current)
    if (style?.display === 'none' || style?.visibility === 'hidden') return true
  }
  return false
}

const getLastTerminalSlotById = (id: string): HTMLElement | null => {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[data-pty-slot]')).filter(
    (node) => node.id === id && node.isConnected && !isHiddenTerminalSlot(node)
  )
  return matches[matches.length - 1] ?? null
}

const getTerminalParkingLot = (): HTMLElement => {
  let node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (!node) {
    node = document.createElement('div')
    node.id = TERMINAL_PARKING_LOT_ID
    node.hidden = true
    node.style.display = 'none'
    const parent = document.body ?? document.documentElement
    parent.appendChild(node)
  }
  return node
}

const cleanupTerminalParkingLot = (): void => {
  const node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (node && node.childElementCount === 0) node.remove()
}

const TERMINAL_SLOT_SELECTOR = '[data-pty-slot]'

const portalTargetSubscribers = new Set<() => void>()
let portalTargetObserver: MutationObserver | undefined
let portalTargetPollTimer: number | undefined

const nodeHasTerminalSlot = (node: Node): boolean => {
  if (!(node instanceof Element)) return false
  return node.matches(TERMINAL_SLOT_SELECTOR) || node.querySelector(TERMINAL_SLOT_SELECTOR) !== null
}

const nodeListHasTerminalSlot = (nodes: NodeList): boolean => {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index)
    if (node && nodeHasTerminalSlot(node)) return true
  }
  return false
}

const mutationTouchesTerminalSlots = (mutation: MutationRecord): boolean => {
  if (mutation.type === 'attributes' && mutation.attributeName === 'data-pty-slot') return true

  if (!(mutation.target instanceof Element)) return false
  if (mutation.target.closest('[data-terminal-host-run-id]')) return false

  if (nodeListHasTerminalSlot(mutation.addedNodes)) return true
  if (nodeListHasTerminalSlot(mutation.removedNodes)) return true

  if (mutation.target === document.body || mutation.target === document.documentElement)
    return false
  return nodeHasTerminalSlot(mutation.target)
}

const notifyPortalTargetSubscribers = (mutations?: MutationRecord[]): void => {
  if (mutations && !mutations.some(mutationTouchesTerminalSlots)) return
  for (const subscriber of portalTargetSubscribers) subscriber()
}

const stopPortalTargetWatcher = (): void => {
  portalTargetObserver?.disconnect()
  portalTargetObserver = undefined
  if (portalTargetPollTimer !== undefined) {
    window.clearInterval(portalTargetPollTimer)
    portalTargetPollTimer = undefined
  }
}

const ensurePortalTargetWatcher = (): void => {
  if (portalTargetObserver || portalTargetPollTimer !== undefined) return
  const root = document.body ?? document.documentElement
  if (typeof MutationObserver !== 'undefined' && root) {
    portalTargetObserver = new MutationObserver(notifyPortalTargetSubscribers)
    portalTargetObserver.observe(root, {
      attributeFilter: [
        'aria-hidden',
        'class',
        'data-pty-slot',
        'data-terminal-auto-focus',
        'hidden',
        'id',
        'style',
      ],
      attributes: true,
      childList: true,
      subtree: true,
    })
    return
  }
  portalTargetPollTimer = window.setInterval(notifyPortalTargetSubscribers, 100)
}

const subscribePortalTargetChanges = (subscriber: () => void): (() => void) => {
  portalTargetSubscribers.add(subscriber)
  ensurePortalTargetWatcher()
  return () => {
    portalTargetSubscribers.delete(subscriber)
    if (portalTargetSubscribers.size === 0) stopPortalTargetWatcher()
  }
}

const VISIBLE_TERMINAL_RESIZE_SETTLE_DELAYS_MS = [50, 150, 300] as const

const isTerminalAutoFocusTarget = (target: HTMLElement | null): target is HTMLElement =>
  target?.dataset.terminalAutoFocus === 'true'

const scheduleVisibleTerminalResize = (runId: string): (() => void) => {
  const animationFrameIds: number[] = []
  const timeoutIds: number[] = []
  const dispatch = () => window.dispatchEvent(createTerminalVisibleResizeEvent(runId))
  const scheduleTimeout = (delayMs: number, action: () => void) => {
    const id = window.setTimeout(() => {
      const index = timeoutIds.indexOf(id)
      if (index >= 0) timeoutIds.splice(index, 1)
      action()
    }, delayMs)
    timeoutIds.push(id)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    const firstFrame = window.requestAnimationFrame(() => {
      dispatch()
      const secondFrame = window.requestAnimationFrame(dispatch)
      animationFrameIds.push(secondFrame)
    })
    animationFrameIds.push(firstFrame)
  } else {
    scheduleTimeout(0, dispatch)
  }

  for (const delayMs of VISIBLE_TERMINAL_RESIZE_SETTLE_DELAYS_MS) {
    scheduleTimeout(delayMs, dispatch)
  }

  return () => {
    for (const id of animationFrameIds) window.cancelAnimationFrame?.(id)
    for (const id of timeoutIds) window.clearTimeout(id)
    animationFrameIds.length = 0
    timeoutIds.length = 0
  }
}

const usePortalTarget = (runId: string): HTMLElement | null => {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const ids = candidateIds(runId)
    const resolve = () => {
      for (const id of ids) {
        const node = getLastTerminalSlotById(id)
        if (node) return node
      }
      return null
    }
    const refreshTarget = () => {
      const node = resolve()
      setTarget((current) => (current === node ? current : node))
    }
    refreshTarget()
    return subscribePortalTargetChanges(refreshTarget)
  }, [runId])
  return target
}

const useStablePortalHost = (runId: string, target: HTMLElement | null): HTMLElement | null => {
  const [activated, setActivated] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const attachedTargetRef = useRef<HTMLElement | null>(null)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const hostRef = useRef<HTMLElement | null>(null)
  const visibleResizeCleanupRef = useRef<(() => void) | undefined>(undefined)

  const clearDisposeTimer = useCallback(() => {
    if (disposeTimerRef.current === undefined) return
    window.clearTimeout(disposeTimerRef.current)
    disposeTimerRef.current = undefined
  }, [])
  const clearVisibleResizeSchedule = useCallback(() => {
    visibleResizeCleanupRef.current?.()
    visibleResizeCleanupRef.current = undefined
  }, [])
  const clearAttachedTarget = useCallback(() => {
    const attachedTarget = attachedTargetRef.current
    if (attachedTarget?.dataset.terminalSlotRunId === runId) {
      delete attachedTarget.dataset.terminalSlotRunId
    }
    attachedTargetRef.current = null
  }, [runId])
  const markAttachedTarget = useCallback(
    (nextTarget: HTMLElement) => {
      const previousTarget = attachedTargetRef.current
      if (previousTarget && previousTarget !== nextTarget) {
        if (previousTarget.dataset.terminalSlotRunId === runId) {
          delete previousTarget.dataset.terminalSlotRunId
        }
      }
      nextTarget.dataset.terminalSlotRunId = runId
      attachedTargetRef.current = nextTarget
    },
    [runId]
  )

  useLayoutEffect(() => {
    const node = document.createElement('div')
    node.dataset.terminalHostRunId = runId
    node.dataset.terminalHostParked = 'false'
    node.className = 'h-full min-h-0 w-full min-w-0'
    hostRef.current = node
    setHost(node)
    return () => {
      clearDisposeTimer()
      clearAttachedTarget()
      clearVisibleResizeSchedule()
      node.remove()
      hostRef.current = null
      cleanupTerminalParkingLot()
    }
  }, [clearAttachedTarget, clearDisposeTimer, clearVisibleResizeSchedule, runId])

  useLayoutEffect(() => {
    if (target) {
      clearDisposeTimer()
      setActivated(true)
      return
    }
    if (!activated || disposeTimerRef.current !== undefined) return

    disposeTimerRef.current = window.setTimeout(() => {
      disposeTimerRef.current = undefined
      setActivated(false)
    }, PARKED_TERMINAL_DISPOSE_DELAY_MS)
    return clearDisposeTimer
  }, [activated, clearDisposeTimer, target])

  useLayoutEffect(() => {
    const node = hostRef.current
    if (!node) return
    if (!activated) {
      clearVisibleResizeSchedule()
      clearAttachedTarget()
      node.remove()
      node.dataset.terminalHostParked = 'false'
      cleanupTerminalParkingLot()
      return
    }

    const parent = target ?? getTerminalParkingLot()
    if (node.parentElement === parent) {
      if (target) markAttachedTarget(target)
      else clearAttachedTarget()
      return
    }

    const hadParent = node.parentElement !== null
    const activeElement = document.activeElement
    if (!target) {
      clearVisibleResizeSchedule()
      clearAttachedTarget()
    }
    if (!target && activeElement instanceof HTMLElement && node.contains(activeElement)) {
      activeElement.blur()
    }
    node.dataset.terminalHostParked = target ? 'false' : 'true'
    parent.appendChild(node)
    if (target) markAttachedTarget(target)
    cleanupTerminalParkingLot()

    if (target && hadParent) {
      clearVisibleResizeSchedule()
      visibleResizeCleanupRef.current = scheduleVisibleTerminalResize(runId)
    }
  }, [
    activated,
    clearAttachedTarget,
    clearVisibleResizeSchedule,
    markAttachedTarget,
    runId,
    target,
  ])

  return activated ? host : null
}

export const TerminalView = ({
  inputProfile = 'default',
  onRunExited,
  runId,
  startupBlockedReason,
  title,
}: TerminalViewProps) => {
  const portalTarget = usePortalTarget(runId)
  const host = useStablePortalHost(runId, portalTarget)

  if (!host) return null
  const autoFocusTarget = isTerminalAutoFocusTarget(portalTarget) ? portalTarget : null
  return createPortal(
    <TerminalPtyView
      autoFocusTarget={autoFocusTarget}
      inputProfile={inputProfile}
      {...(onRunExited ? { onRunExited } : {})}
      runId={runId}
      startupBlockedReason={startupBlockedReason ?? null}
      title={title}
    />,
    host
  )
}

const TerminalPtyView = ({
  autoFocusTarget,
  inputProfile,
  onRunExited,
  runId,
  startupBlockedReason,
  title: _title,
}: TerminalViewProps & { autoFocusTarget: HTMLElement | null }) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const handleExit = useCallback(() => {
    onRunExited?.(runId)
  }, [onRunExited, runId])
  const { containerRef, error, status, isScrolledUp, scrollToBottom } = useTerminalRun(
    runId,
    inputProfile,
    handleExit,
    { autoFocusTarget }
  )
  const statusKey = STATUS_KEYS[status]
  const handleScrollToBottom = useCallback(() => {
    containerRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.blur()
    scrollToBottom()
  }, [containerRef, scrollToBottom])
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
      {!error && startupBlockedReason === 'first_run_setup' ? (
        <p
          className="mono shrink-0 break-words px-3 py-2 text-xs"
          data-testid={`terminal-startup-setup-${runId}`}
          style={{
            background: 'color-mix(in oklab, var(--status-orange) 12%, transparent)',
            borderBottom: '1px solid color-mix(in oklab, var(--status-orange) 28%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {t('terminal.firstRunSetup')}
        </p>
      ) : null}
      <div className="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        <div
          data-testid={`terminal-${runId}`}
          ref={containerRef}
          className="bg-crust h-full min-h-0 w-full min-w-0 overflow-auto"
        />
        {!error && status === 'connecting' ? (
          <div
            role="status"
            className="mono pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('terminal.statusConnecting')}
          </div>
        ) : null}
        {isMobile && isScrolledUp ? (
          <TerminalJumpToBottomButton
            label={t('terminal.scrollToBottom')}
            onJump={handleScrollToBottom}
          />
        ) : null}
      </div>
    </div>
  )
}

const TerminalJumpToBottomButton = ({ label, onJump }: { label: string; onJump: () => void }) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const lastJumpPressAtRef = useRef(Number.NEGATIVE_INFINITY)

  const runJump = useCallback(
    (event: { preventDefault?: () => void; stopPropagation?: () => void; timeStamp?: number }) => {
      event.preventDefault?.()
      event.stopPropagation?.()
      const timestamp = event.timeStamp ?? performance.now()
      if (timestamp - lastJumpPressAtRef.current < 250) return
      lastJumpPressAtRef.current = timestamp
      onJump()
    },
    [onJump]
  )

  useEffect(() => {
    const button = buttonRef.current
    if (!button) return
    const handleNativePress = (event: Event) => {
      if (event.cancelable) event.preventDefault()
      event.stopImmediatePropagation()
      runJump(event)
    }
    button.addEventListener('touchstart', handleNativePress, {
      capture: true,
      passive: false,
    })
    button.addEventListener('pointerdown', handleNativePress, { capture: true })
    button.addEventListener('mousedown', handleNativePress, { capture: true })
    return () => {
      button.removeEventListener('touchstart', handleNativePress, { capture: true })
      button.removeEventListener('pointerdown', handleNativePress, { capture: true })
      button.removeEventListener('mousedown', handleNativePress, { capture: true })
    }
  }, [runJump])

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      className="icon-btn icon-btn--primary mobile-terminal-jump-button absolute bottom-2 left-1/2 -translate-x-1/2"
      tabIndex={-1}
      onClick={runJump}
      onFocus={(event) => event.currentTarget.blur()}
    >
      {label}
    </button>
  )
}
