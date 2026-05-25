import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { HIVE_USAGE, handleHiveInfoCommand, runHiveCommand } from '../../src/cli/hive.js'
import {
  defaultRunUpdate,
  HIVE_UPDATE_USAGE,
  type RunUpdate,
  runHiveUpdateCommand,
} from '../../src/cli/hive-update.js'

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
          install_hint: 'npm install -g @tt-a1i/hive@latest',
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
          'Hive update available: 0.6.0-alpha.3 -> 0.6.0-alpha.4. Run: npm install -g @tt-a1i/hive@latest'
        )
      })
    } finally {
      await result.close()
    }
  })
})

describe('hive update cli', () => {
  test('--help prints update usage and exits 0 without invoking npm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand(['--help'], { runUpdate })

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(HIVE_UPDATE_USAGE)
    expect(runUpdateInvoked).toBe(false)
  })

  test('successful npm install exits 0 and prints a restart hint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const runUpdate: RunUpdate = async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(0)
    expect(calls).toEqual([{ command: 'npm', args: ['install', '-g', '@tt-a1i/hive@latest'] }])
    expect(logSpy).toHaveBeenCalledWith('Running: npm install -g @tt-a1i/hive@latest')
    expect(logSpy).toHaveBeenCalledWith(
      'Hive updated. Restart any running Hive process to pick up the new version.'
    )
  })

  test('non-zero npm exit propagates the code, prints an error, and offers the manual fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runUpdate: RunUpdate = async () => ({ exitCode: 7 })

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(7)
    expect(errorSpy).toHaveBeenCalledWith('npm install exited with code 7.')
    // EACCES / sudo-required installs land here; the recovery hint must be
    // surfaced on this path too, not only on spawn ENOENT.
    expect(errorSpy).toHaveBeenCalledWith(
      'You can run the upgrade manually: npm install -g @tt-a1i/hive@latest'
    )
  })

  test('spawn error (npm not on PATH) exits 1 and surfaces the manual fallback hint', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runUpdate: RunUpdate = async () => ({
      exitCode: 1,
      spawnError: new Error('spawn npm ENOENT'),
    })

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn npm: spawn npm ENOENT')
    expect(errorSpy).toHaveBeenCalledWith(
      'You can run the upgrade manually: npm install -g @tt-a1i/hive@latest'
    )
  })

  test('unknown arguments are rejected before invoking npm', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand(['--bogus'], { runUpdate })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Unknown argument: --bogus')
    expect(runUpdateInvoked).toBe(false)
  })

  test('on Windows the spawned command is `npm.cmd`, not `npm`', async () => {
    // Without the `.cmd` suffix Node's child_process.spawn cannot resolve the
    // Windows batch shim, so every Windows user would land in the spawn-error
    // fallback. The cross-platform tests cover npm; this one nails Windows.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ command: string }> = []
    const runUpdate: RunUpdate = async (command) => {
      calls.push({ command })
      return { exitCode: 0 }
    }

    await runHiveUpdateCommand([], { runUpdate, platform: 'win32' })

    expect(calls).toEqual([{ command: 'npm.cmd' }])
  })

  test('on darwin and linux the spawned command is `npm`', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const platform of ['darwin', 'linux'] as const) {
      const calls: Array<{ command: string }> = []
      const runUpdate: RunUpdate = async (command) => {
        calls.push({ command })
        return { exitCode: 0 }
      }
      await runHiveUpdateCommand([], { runUpdate, platform })
      expect(calls).toEqual([{ command: 'npm' }])
    }
  })
})

describe('defaultRunUpdate (real spawn)', () => {
  test('translates a non-zero exit from a real child process into RunUpdateResult', async () => {
    // Use node itself as a stand-in for npm: it's guaranteed to be in PATH
    // wherever this test runs. `-e "process.exit(7)"` exercises the entire
    // spawn -> stdio close -> exit-code-translation path that the consumer
    // tests above mock away.
    const result = await defaultRunUpdate(process.execPath, ['-e', 'process.exit(7)'])

    expect(result.exitCode).toBe(7)
    expect(result.spawnError).toBeUndefined()
  })

  test('translates ENOENT from a missing binary into spawnError', async () => {
    const result = await defaultRunUpdate('definitely-not-a-binary-9f3a2c', ['arg'])

    expect(result.exitCode).toBe(1)
    expect(result.spawnError).toBeInstanceOf(Error)
    expect(result.spawnError?.message).toMatch(/ENOENT|spawn/i)
  })
})

describe('hive cli dispatch (real subprocess)', () => {
  // Pin the full chain `process.argv → src/cli/hive.ts dispatch →
  // runHiveUpdateCommand`. Every other test in this file stops short of the
  // dispatch glue; this one proves typing `hive update --help` actually
  // reaches the new subcommand rather than falling through to `runHiveCommand`.
  test('`hive update --help` exits 0 with the update usage on stdout', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('node_modules/.bin/tsx', ['src/cli/hive.ts', 'update', '--help'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Runs `npm install -g @tt-a1i/hive@latest`')
    expect(result.stdout).toContain('hive update')
    // Update help must NOT print the generic `hive` usage with `--port`.
    expect(result.stdout).not.toContain('--port <port>')
  })
})
