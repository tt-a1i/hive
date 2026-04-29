// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
      onClick={() => show({ kind, message, durationMs })}
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
})
