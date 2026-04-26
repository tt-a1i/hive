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

  test('defers Claude input until the prompt is ready and submits in one bracketed paste write', () => {
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
    expect(manager.writeInput).toHaveBeenNthCalledWith(
      1,
      'run-1',
      '\u001b[200~payload\u001b[201~\r'
    )
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
