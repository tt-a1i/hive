// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider, useToast } from '../../web/src/ui/useToast.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

const wrap = (children: ReactNode) => (
  <ToastProvider>
    {children}
    <Toaster />
  </ToastProvider>
)

const ShowButton = ({
  kind,
  message,
  durationMs,
}: {
  kind: 'success' | 'warning' | 'error'
  message: string
  durationMs?: number
}) => {
  const { show } = useToast()
  return (
    <button
      type="button"
      data-testid={`show-${kind}`}
      onClick={() =>
        show(durationMs === undefined ? { kind, message } : { kind, message, durationMs })
      }
    >
      show
    </button>
  )
}

describe('Toast system', () => {
  test('show success toast — appears, then auto-dismisses after 3000ms', () => {
    render(wrap(<ShowButton kind="success" message="hi" />))
    fireEvent.click(screen.getByTestId('show-success'))

    expect(screen.getByTestId('toast').textContent).toContain('hi')
    expect(screen.getByTestId('toast').getAttribute('data-kind')).toBe('success')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('error toast — stays until manual close (durationMs=0 default for error)', () => {
    render(wrap(<ShowButton kind="error" message="boom" />))
    fireEvent.click(screen.getByTestId('show-error'))

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('toast-close'))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('warning toast — auto-dismisses after 5000ms', () => {
    render(wrap(<ShowButton kind="warning" message="careful" />))
    fireEvent.click(screen.getByTestId('show-warning'))

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('explicit durationMs override wins', () => {
    render(wrap(<ShowButton kind="success" message="custom" durationMs={500} />))
    fireEvent.click(screen.getByTestId('show-success'))

    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('throws when used outside provider', () => {
    const Bad = () => {
      useToast()
      return null
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/ToastProvider/)
    consoleError.mockRestore()
  })

  test('useToast() return value is referentially stable across toast list changes (B1 regression)', () => {
    // B1: consumer using `useEffect(..., [toast])` must NOT re-run when the
    // toast list mutates. Pre-fix the api object was rebuilt on every Provider
    // render → effects looped → toast storms.
    let showCount = 0
    let effectRunCount = 0

    const Consumer = () => {
      const toast = useToast()
      useEffect(() => {
        effectRunCount += 1
        showCount += 1
        toast.show({ kind: 'success', message: `m${showCount}` })
      }, [toast])
      return null
    }

    render(
      <ToastProvider>
        <Consumer />
        <Toaster />
      </ToastProvider>
    )

    // Effect runs exactly once on mount; the toast.show inside causes a
    // Provider re-render (toast list changed), but the api object is memoized
    // so its identity does NOT change → effect deps don't fire again.
    expect(effectRunCount).toBe(1)
    expect(showCount).toBe(1)
    expect(screen.getAllByTestId('toast')).toHaveLength(1)
  })

  test('toast list capped at 3 — older entries are evicted under storm', () => {
    const Storm = () => {
      const { show } = useToast()
      return (
        <button
          type="button"
          data-testid="storm"
          onClick={() => {
            for (let index = 0; index < 5; index += 1) {
              show({ kind: 'error', message: `boom-${index}` })
            }
          }}
        >
          storm
        </button>
      )
    }
    render(
      <ToastProvider>
        <Storm />
        <Toaster />
      </ToastProvider>
    )
    fireEvent.click(screen.getByTestId('storm'))
    const toasts = screen.getAllByTestId('toast')
    expect(toasts).toHaveLength(3)
    // Oldest two evicted: boom-0 and boom-1; newest 3 retained.
    expect(toasts[0]?.textContent).toContain('boom-2')
    expect(toasts[2]?.textContent).toContain('boom-4')
  })

  test('cleanup on unmount clears all pending timers (no React warnings)', () => {
    const Pusher = () => {
      const { show } = useToast()
      useEffect(() => {
        show({ kind: 'success', message: 'a' })
        show({ kind: 'success', message: 'b' })
      }, [show])
      return null
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(
      <ToastProvider>
        <Pusher />
        <Toaster />
      </ToastProvider>
    )
    unmount()
    // Advance past timer expiry — if cleanup didn't clearTimeout, the queued
    // dismiss callback would fire on an unmounted component and React would
    // warn (logged via console.error).
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
