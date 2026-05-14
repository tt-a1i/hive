import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostStartInputWriter,
  hasBracketedPasteAcknowledgement,
  hasInteractivePromptReady,
} from '../../src/server/post-start-input-writer.js'

describe('post-start input writer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('recognizes interactive TUI prompts', () => {
    expect(hasInteractivePromptReady('booting\n❯ ')).toBe(true)
    expect(hasInteractivePromptReady('booting\n› ')).toBe(true)
    expect(
      hasInteractivePromptReady('Gemini CLI\n* Type your message or @path/to/file', 'gemini')
    ).toBe(true)
    expect(hasInteractivePromptReady('booting only')).toBe(false)
  })

  test('recognizes Claude bracketed-paste acknowledgements after the baseline output', () => {
    const baseline = 'Welcome back\n❯ '
    expect(
      hasBracketedPasteAcknowledgement(`${baseline}[Pasted text #1 +25 lines]`, baseline.length)
    ).toBe(true)
    const oldOutput = `${baseline}old [Pasted text #1]`
    expect(hasBracketedPasteAcknowledgement(oldOutput, oldOutput.length)).toBe(false)
  })

  test('defers Claude input until prompt and paste acknowledgement are ready, then submits Enter', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n'
    const manager = {
      getRun: vi.fn(() => ({ output })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    expect(manager.writeInput).not.toHaveBeenCalled()
    output = 'Welcome back\n❯ '
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    expect(manager.writeInput).toHaveBeenNthCalledWith(1, 'run-1', '\u001b[200~payload\u001b[201~')

    vi.advanceTimersByTime(600)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    output += '[Pasted text #1 +1 lines]\n'
    vi.advanceTimersByTime(149)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('waits longer before submitting large pasted prompts after acknowledgement', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n❯ '
    const manager = {
      getRun: vi.fn(() => ({ output })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload\n'.repeat(600))

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    output += '[Pasted text #1 +600 lines]\n'
    vi.advanceTimersByTime(200)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1300)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('submits Claude pasted input after timeout when no paste acknowledgement is emitted', () => {
    vi.useFakeTimers()
    const manager = {
      getRun: vi.fn(() => ({ output: 'Welcome back\n❯ ' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    vi.advanceTimersByTime(2999)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('waits for Gemini prompt readiness and writes plain input without bracketed paste', () => {
    vi.useFakeTimers()
    let output = 'Gemini CLI v0.35.3\nAuthenticated with gemini-api-key'
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'gemini')
    write('run-1', '[Hive 系统消息：启动说明]\n请基于此继续。')

    vi.advanceTimersByTime(5000)
    expect(manager.writeInput).not.toHaveBeenCalled()

    output += '\n* Type your message or @path/to/file'
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    expect(manager.writeInput).toHaveBeenNthCalledWith(
      1,
      'run-1',
      '[Hive 系统消息：启动说明]\n请基于此继续。'
    )
    expect(manager.writeInput.mock.calls[0]?.[1]).not.toContain('\u001b[200~')
    expect(manager.writeInput.mock.calls[0]?.[1]).not.toContain('\u001b[201~')

    vi.advanceTimersByTime(600)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('does not submit delayed Enter after the PTY exits', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n❯ '
    let status = 'running'
    const manager = {
      getRun: vi.fn(() => ({ output, status })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    status = 'exited'
    output += '[Pasted text #1 +1 lines]\n'
    vi.advanceTimersByTime(3000)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
  })

  test('does not write delayed interactive input after the PTY exits before prompt readiness', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n'
    let status = 'running'
    const manager = {
      getRun: vi.fn(() => ({ output, status })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    status = 'exited'
    output = 'Welcome back\n❯ '
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).not.toHaveBeenCalled()
  })

  test('writes non-interactive commands immediately', () => {
    const manager = {
      getRun: vi.fn(() => ({ output: '', status: 'running' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, process.execPath)
    write('run-1', 'payload')

    expect(manager.getRun).toHaveBeenCalledWith('run-1')
    expect(manager.writeInput).toHaveBeenCalledWith('run-1', 'payload\n')
  })

  test('skips non-interactive post-start input after the run exits', () => {
    const manager = {
      getRun: vi.fn(() => ({ output: '', status: 'exited' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, process.execPath)
    write('run-1', 'payload')

    expect(manager.writeInput).not.toHaveBeenCalled()
  })
})
