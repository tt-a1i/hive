// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TaskGraphDrawer } from '../../web/src/tasks/TaskGraphDrawer.js'

afterEach(() => cleanup())

/**
 * Shared no-op props every test needs. Spread, then override the bits a
 * specific test cares about. Mirrors the prop shape of the production
 * `WorkspaceTaskDrawer` adapter but with stubs so we can assert wiring
 * without dragging the real `useTasksFile` / WebSocket plumbing into a unit
 * test.
 */
const baseProps = () => ({
  content: '',
  hasConflict: false,
  open: true,
  workspacePath: '/tmp/ws',
  onClose: vi.fn(),
  onContentChange: vi.fn(),
  onKeepLocal: vi.fn(),
  onReload: vi.fn(),
  onSave: vi.fn(async () => {}),
  onToggleTaskLine: vi.fn(),
  onAppendTask: vi.fn(),
  onAppendSubtask: vi.fn(),
  onUpdateTaskText: vi.fn(),
  onDeleteTask: vi.fn(),
})

describe('TaskGraphDrawer §6.6.5 — folding is in-memory only', () => {
  test('clicking the collapse toggle hides the child list without writing to the file', () => {
    const props = baseProps()
    render(
      <TaskGraphDrawer {...props} content={'- [ ] parent\n  - [ ] child A\n  - [ ] child B\n'} />
    )
    // Children visible before any interaction
    expect(screen.queryByTestId('task-line-1')).not.toBeNull()
    expect(screen.queryByTestId('task-line-2')).not.toBeNull()
    fireEvent.click(screen.getByTestId('task-collapse-0'))
    // After collapse, the parent's children container is gone — checking
    // children, not the toggle itself, because a buggy toggle that only
    // flips the icon would still leave children mounted.
    expect(screen.queryByTestId('task-line-1')).toBeNull()
    expect(screen.queryByTestId('task-line-2')).toBeNull()
    // And no file mutations: this is purely a view-state change.
    expect(props.onContentChange).not.toHaveBeenCalled()
    expect(props.onUpdateTaskText).not.toHaveBeenCalled()
  })

  test('aria-expanded reflects fold state for screen readers', () => {
    render(<TaskGraphDrawer {...baseProps()} content={'- [ ] parent\n  - [ ] child\n'} />)
    const toggle = screen.getByTestId('task-collapse-0')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('TaskGraphDrawer §6.6.6 — chip click is the cross-pane jump', () => {
  test('clicking an owner chip fires onSelectOwner with the bare worker name (no `@`)', () => {
    const onSelectOwner = vi.fn()
    render(
      <TaskGraphDrawer
        {...baseProps()}
        content={'- [ ] write tests @Alice\n'}
        knownWorkerNames={['Alice', 'Bob']}
        onSelectOwner={onSelectOwner}
      />
    )
    fireEvent.click(screen.getByTestId('task-mention-Alice'))
    expect(onSelectOwner).toHaveBeenCalledTimes(1)
    expect(onSelectOwner).toHaveBeenCalledWith('Alice')
  })

  test('without onSelectOwner the chip is a plain span, not a button', () => {
    render(
      <TaskGraphDrawer
        {...baseProps()}
        content={'- [ ] write tests @Alice\n'}
        knownWorkerNames={['Alice']}
      />
    )
    const chip = screen.getByTestId('task-mention-Alice')
    // <span> not <button>: clicking does nothing, and there's no interactive
    // affordance for assistive tech.
    expect(chip.tagName).toBe('SPAN')
  })
})

describe('TaskGraphDrawer §6.6.4 — connection stale disables writes', () => {
  test('checkbox toggle is disabled and onToggleTaskLine is not called', () => {
    const props = baseProps()
    render(<TaskGraphDrawer {...props} connectionStale content={'- [ ] disabled task\n'} />)
    const checkbox = screen.getByTestId('task-checkbox-0') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    fireEvent.click(checkbox)
    expect(props.onToggleTaskLine).not.toHaveBeenCalled()
  })

  test('hover action cluster hides Edit / Add subtask / Delete entries', () => {
    render(<TaskGraphDrawer {...baseProps()} connectionStale content={'- [ ] stale task\n'} />)
    // Stale path: write-shaped affordances should not be in the DOM at all
    // (vs. just disabled), so even programmatic click attempts can't fire.
    expect(screen.queryByTestId('task-edit-0')).toBeNull()
    expect(screen.queryByTestId('task-delete-0')).toBeNull()
    expect(screen.queryByTestId('task-add-subtask-0')).toBeNull()
    // Read affordance ([复制]) stays available.
    expect(screen.getByTestId('task-copy-0')).toBeInTheDocument()
  })

  test('drawer root carries the connection-stale data attribute for CSS selectors', () => {
    render(<TaskGraphDrawer {...baseProps()} connectionStale content={'- [ ] x\n'} />)
    const drawer = screen.getByTestId('task-graph-drawer')
    expect(drawer.getAttribute('data-connection-stale')).toBe('true')
  })
})

describe('TaskGraphDrawer §6.6.6 — copy line', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  test('copies the *raw markdown line* including the `@<name>` prefix', () => {
    // Keeps the source-of-truth shape so pasting back into the orchestrator
    // chat lands a self-contained, parseable line.
    render(
      <TaskGraphDrawer
        {...baseProps()}
        content={'- [ ] write **tests** for @Alice\n- [ ] another\n'}
      />
    )
    fireEvent.click(screen.getByTestId('task-copy-0'))
    expect(writeText).toHaveBeenCalledWith('- [ ] write **tests** for @Alice')
  })

  test('flips the Copy button to a ✓ confirmation for ~1.5s after a click', () => {
    vi.useFakeTimers()
    try {
      render(<TaskGraphDrawer {...baseProps()} content={'- [ ] task to copy\n'} />)
      const copyButton = screen.getByTestId('task-copy-0')
      // Resting state — aria-label confirms the verb, not the past tense.
      expect(copyButton).toHaveAttribute('aria-label', 'Copy task line')
      fireEvent.click(copyButton)
      // Immediately after click: same DOM node, but now in confirmation state.
      // We assert on aria-label (semantic) rather than the icon SVG, so the
      // test stays meaningful if the icon library swaps its glyph.
      expect(copyButton).toHaveAttribute('aria-label', 'Copied task line')
      // Advance fake timers inside `act` so React flushes the `setCopied(false)`
      // state update; otherwise the DOM still reflects the previous render.
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(copyButton).toHaveAttribute('aria-label', 'Copy task line')
    } finally {
      vi.useRealTimers()
    }
  })

  test('rapid second click resets the timer rather than racing it to revert early', () => {
    vi.useFakeTimers()
    try {
      render(<TaskGraphDrawer {...baseProps()} content={'- [ ] task\n'} />)
      const copyButton = screen.getByTestId('task-copy-0')
      fireEvent.click(copyButton)
      act(() => {
        vi.advanceTimersByTime(1000) // first click: 1000ms elapsed, 500ms left
      })
      fireEvent.click(copyButton) // second click: timer reset to fresh 1500ms
      act(() => {
        vi.advanceTimersByTime(1000) // now 1000ms after second click
      })
      // Without the reset, the original 1500ms timer would have fired by now
      // and reverted to "Copy task line". With the reset, we're still inside
      // the second click's 1500ms window.
      expect(copyButton).toHaveAttribute('aria-label', 'Copied task line')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TaskGraphDrawer §6.6.3 — N/M progress badge', () => {
  test('renders direct-child completion as `done/total` on the parent row', () => {
    render(
      <TaskGraphDrawer
        {...baseProps()}
        content={'- [ ] parent\n  - [x] one done\n  - [ ] still open\n'}
      />
    )
    expect(screen.getByTestId('task-progress-0')).toHaveTextContent('1/2')
  })

  test('a leaf task (no direct checkbox children) does not render the badge', () => {
    render(<TaskGraphDrawer {...baseProps()} content={'- [ ] standalone\n'} />)
    expect(screen.queryByTestId('task-progress-0')).toBeNull()
  })
})

describe('TaskGraphDrawer §6.6.7 — Esc closes the drawer', () => {
  test('Escape on the drawer container triggers onClose', () => {
    const props = baseProps()
    render(<TaskGraphDrawer {...props} content={'- [ ] task\n'} />)
    const drawer = screen.getByTestId('task-graph-drawer')
    fireEvent.keyDown(drawer, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape from inside an open inline editor stays scoped to the editor (no drawer close)', () => {
    // The inline editor cancels on Escape (its own handler); the drawer
    // shouldn't see the event because the input is the actual target and the
    // drawer's handler skips TextArea/Input target tags.
    const props = baseProps()
    render(<TaskGraphDrawer {...props} content={'- [ ] click me to edit\n'} />)
    fireEvent.click(screen.getByTestId('task-edit-0'))
    const input = screen.getByTestId('task-inline-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
