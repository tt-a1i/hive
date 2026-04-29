import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostStartInputWriter,
  hasInteractivePromptReady,
} from '../../src/server/post-start-input-writer.js'

describe('post-start input writer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('recognizes interactive TUI prompts', () => {
    expect(hasInteractivePromptReady('booting\n❯ ')).toBe(true)
    expect(hasInteractivePromptReady('booting\n› ')).toBe(true)
    expect(hasInteractivePromptReady('booting only')).toBe(false)
  })

  test('defers Claude input until the prompt is ready, then submits after bracketed paste', () => {
    vi.useFakeTimers()
    const manager = {
      getRun: vi
        .fn()
        .mockReturnValueOnce({ output: 'Welcome back\n' })
        .mockReturnValueOnce({ output: 'Welcome back\n❯ ' }),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    expect(manager.writeInput).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    expect(manager.writeInput).toHaveBeenNthCalledWith(1, 'run-1', '\u001b[200~payload\u001b[201~')

    vi.advanceTimersByTime(599)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('waits longer before submitting large pasted prompts', () => {
    vi.useFakeTimers()
    const manager = {
      getRun: vi.fn().mockReturnValue({ output: 'Welcome back\n❯ ' }),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload\n'.repeat(600))

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1300)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('writes non-interactive commands immediately', () => {
    const manager = {
      getRun: vi.fn(),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, process.execPath)
    write('run-1', 'payload')

    expect(manager.getRun).not.toHaveBeenCalled()
    expect(manager.writeInput).toHaveBeenCalledWith('run-1', 'payload\n')
  })
})
