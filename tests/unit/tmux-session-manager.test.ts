import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ pid: 123 })),
}))

import { execFileSync } from 'node:child_process'

import {
  buildSessionName,
  hasTmux,
  isSessionAlive,
  killSession,
  listHiveSessions,
} from '../../src/server/tmux-session-manager.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hasTmux', () => {
  test('returns true when execFileSync succeeds', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'))
    expect(hasTmux()).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['-V'], { stdio: 'pipe' })
  })

  test('returns false when execFileSync throws', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })
    expect(hasTmux()).toBe(false)
  })
})

describe('buildSessionName', () => {
  test('produces correct format with normal input', () => {
    const result = buildSessionName('ws-1234-abcd', 'agent-1', 'Alice')
    expect(result).toBe('hive-ws-1-Alice')
  })

  test('sanitizes special characters', () => {
    const result = buildSessionName('abcd-efgh', 'agent-2', '米芾 (coder)')
    expect(result).toBe('hive-abcd-----coder-')
  })
})

describe('listHiveSessions', () => {
  test('filters sessions with hive- prefix', () => {
    vi.mocked(execFileSync).mockReturnValue(
      'hive-ws01-Alice\nother-session\nhive-ws02-Bob\n'
    )
    expect(listHiveSessions()).toEqual(['hive-ws01-Alice', 'hive-ws02-Bob'])
  })

  test('returns empty array when tmux is not available', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no tmux')
    })
    expect(listHiveSessions()).toEqual([])
  })
})

describe('isSessionAlive', () => {
  test('returns true when has-session succeeds', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''))
    expect(isSessionAlive('hive-ws01-Alice')).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['has-session', '-t', 'hive-ws01-Alice'], {
      stdio: 'pipe',
    })
  })

  test('returns false when has-session throws', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no session')
    })
    expect(isSessionAlive('hive-ws01-Alice')).toBe(false)
  })
})

describe('killSession', () => {
  test('does not throw when kill-session fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('already dead')
    })
    expect(() => killSession('hive-ws01-Alice')).not.toThrow()
  })
})
