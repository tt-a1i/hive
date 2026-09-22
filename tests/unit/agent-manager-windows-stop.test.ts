import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentRunRecord } from '../../src/server/agent-manager.js'
import {
  attachAgentPty,
  withSilencedConptyConsoleListAgent,
} from '../../src/server/agent-manager-support.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process') as typeof import('node:child_process')

const createRun = (): AgentRunRecord => ({
  agentId: 'agent-1',
  exitCode: null,
  output: '',
  pid: 4242,
  process: {
    isStopped: () => false,
    pause() {},
    pid: 4242,
    resize() {},
    resume() {},
    stop() {},
    write() {},
  },
  runId: 'run-1',
  status: 'running',
})

const createPty = () => ({
  kill: vi.fn(),
  on: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  pause: vi.fn(),
  pid: 4242,
  resize: vi.fn(),
  resume: vi.fn(),
  write: vi.fn(),
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('attachAgentPty Windows stop', () => {
  test('can retry termination after a synchronous PTY failure', () => {
    vi.useFakeTimers()
    const run = createRun()
    const denied = Object.assign(new Error('termination denied'), { code: 'EPERM' })
    let deniedOnce = true
    let exit: (event: { exitCode: number }) => void = () => {}
    const pty = {
      ...createPty(),
      pid: 0,
      onExit(listener: typeof exit) {
        exit = listener
      },
      kill() {
        if (deniedOnce) {
          deniedOnce = false
          throw denied
        }
        exit({ exitCode: 0 })
      },
    }
    attachAgentPty(run, pty as never, createPtyOutputBus(), 'win32')

    expect(() => run.process.stop()).toThrow(denied)
    expect(run.status).toBe('running')
    run.process.stop()
    expect(run.status).toBe('exited')
    expect(run.exitCode).toBe(0)
    expect(run.process.isStopped()).toBe(true)
    vi.clearAllTimers()
  })

  test('uses taskkill before the delayed pty cleanup fallback', async () => {
    vi.useFakeTimers()
    const run = createRun()
    const pty = createPty()
    let calls = 0
    const taskkill = vi.fn((_cmd, _args, done) => {
      calls += 1
      if (calls === 2) done(false)
    })

    attachAgentPty(run, pty as never, createPtyOutputBus(), 'win32', taskkill)

    run.process.stop()
    expect(pty.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(751)

    expect(taskkill).toHaveBeenNthCalledWith(
      1,
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.any(Function)
    )
    expect(taskkill).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.any(Function)
    )
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  test('still falls back to pty.kill when taskkill reports failure', () => {
    const run = createRun()
    const pty = createPty()

    attachAgentPty(run, pty as never, createPtyOutputBus(), 'win32', (_cmd, _args, done) =>
      done(false)
    )

    run.process.stop()

    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  test('silences node-pty conpty helper stderr when pty.kill runs after taskkill', () => {
    const originalFork = childProcess.fork
    const child = new childProcess.ChildProcess()
    child.stderr = new PassThrough()
    child.stdout = new PassThrough()
    const stderrResume = vi.spyOn(child.stderr, 'resume')
    const stdoutResume = vi.spyOn(child.stdout, 'resume')
    const fork = vi.fn(() => child)
    childProcess.fork = fork as unknown as typeof childProcess.fork

    try {
      withSilencedConptyConsoleListAgent('win32', () => {
        childProcess.fork('C:\\node-pty\\lib\\conpty_console_list_agent', ['4242'])
      })
    } finally {
      childProcess.fork = originalFork
    }

    expect(fork).toHaveBeenCalledWith(
      'C:\\node-pty\\lib\\conpty_console_list_agent',
      ['4242'],
      expect.objectContaining({ silent: true })
    )
    expect(stderrResume).toHaveBeenCalledTimes(1)
    expect(stdoutResume).toHaveBeenCalledTimes(1)
  })
})
