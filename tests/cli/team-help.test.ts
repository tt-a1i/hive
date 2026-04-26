import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('team cli help', () => {
  test('prints usage without requiring Hive agent environment', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['--help'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('Usage:')
    expect(output).toContain('team list')
    expect(output).toContain('team send <worker-name> "<task>"')
    expect(output).toContain('team report "<result>"')
  })
})
