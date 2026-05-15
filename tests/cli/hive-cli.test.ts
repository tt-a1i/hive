import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { HIVE_USAGE, handleHiveInfoCommand, runHiveCommand } from '../../src/cli/hive.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hive cli', () => {
  test('prints help without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(handleHiveInfoCommand(['--help'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(HIVE_USAGE)
  })

  test('prints package version without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

    expect(handleHiveInfoCommand(['--version'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(version)
  })

  test('rejects unknown arguments instead of ignoring them', async () => {
    await expect(runHiveCommand(['--bogus'])).rejects.toThrow('Unknown option: --bogus')
    await expect(runHiveCommand(['--port', '0', 'extra'])).rejects.toThrow(
      'Unknown argument: extra'
    )
  })

  test('starts http server and prints listening address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'])

    try {
      expect(result.port).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(`Hive running at http://127.0.0.1:${result.port}`)
    } finally {
      await result.close()
    }
  })

  test('prints a non-blocking update hint after startup when a newer npm version exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'], {
      versionService: {
        getVersionInfo: async () => ({
          current_version: '0.6.0-alpha.3',
          install_hint: 'npm update -g @tt-a1i/hive',
          latest_version: '0.6.0-alpha.4',
          package_name: '@tt-a1i/hive',
          release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          update_available: true,
        }),
      },
    })

    try {
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(
          'Hive update available: 0.6.0-alpha.3 -> 0.6.0-alpha.4. Run: npm update -g @tt-a1i/hive'
        )
      })
    } finally {
      await result.close()
    }
  })
})
