import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  DEFAULT_HIVE_PORT,
  formatPortAccessDeniedMessage,
  HIVE_USAGE,
  handleHiveInfoCommand,
  runHiveCommand,
  SHUTDOWN_SIGNALS,
} from '../../src/cli/hive.js'
import {
  defaultRunUpdate,
  FORWARDED_UPDATE_SIGNALS,
  HIVE_UPDATE_USAGE,
  killUpdateChild,
  planSpawnInvocation,
  type RunUpdate,
  resolveHiveUpdateInstallArgs,
  runHiveUpdateCommand,
} from '../../src/cli/hive-update.js'

import { getNpmCommand } from '../../src/server/package-version.js'
import { formatUpdateCommand } from '../../src/server/update-install-plan.js'

const ignoreScripts = '--ignore-scripts'

const nodeRequire = createRequire(import.meta.url)
const tempRoots: string[] = []

const createNpmGlobalInstallModuleUrl = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-update-npm-global-'))
  tempRoots.push(root)
  const prefix = join(root, 'custom prefix')
  const packageRoot = join(prefix, 'node_modules/@tt-a1i/hive')
  const cliDir = join(packageRoot, 'dist/src/cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tt-a1i/hive' }))
  return { moduleUrl: pathToFileURL(join(cliDir, 'hive-update.js')).href, prefix }
}

beforeEach(() => {
  const configRoot = mkdtempSync(join(tmpdir(), 'hive-update-config-'))
  tempRoots.push(configRoot)
  vi.stubEnv('HIVE_DATA_DIR', join(configRoot, 'data'))
  for (const config of ['user', 'global']) {
    const file = join(configRoot, `${config}.npmrc`)
    writeFileSync(file, '')
    vi.stubEnv(`npm_config_${config}config`, file)
  }
  vi.stubEnv('npm_config_ignore_scripts', 'false')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('hive cli — shutdown signals', () => {
  test('SHUTDOWN_SIGNALS covers Windows-relevant signals beyond SIGTERM', () => {
    // POSIX-only SIGTERM/SIGINT is not enough on Windows. CTRL_CLOSE_EVENT
    // (window X) surfaces as SIGHUP via libuv, and Ctrl+Break surfaces as
    // SIGBREAK. Without those two registered, the most common Windows
    // exit paths skip graceful shutdown entirely. SIGTERM stays in the
    // list as the POSIX `kill` happy path; SIGINT covers Ctrl+C across
    // all platforms.
    expect(SHUTDOWN_SIGNALS).toContain('SIGINT')
    expect(SHUTDOWN_SIGNALS).toContain('SIGTERM')
    expect(SHUTDOWN_SIGNALS).toContain('SIGHUP')
    expect(SHUTDOWN_SIGNALS).toContain('SIGBREAK')
  })

  test('hive update forwards the same Windows-relevant signals to its npm child', () => {
    // The runtime and the upgrade child both need to handle window-close
    // (SIGHUP via CTRL_CLOSE_EVENT) and Ctrl+Break (SIGBREAK) on Windows
    // — otherwise the npm install can outlive the runtime when a user
    // closes the cmd window mid-upgrade.
    expect(FORWARDED_UPDATE_SIGNALS).toContain('SIGINT')
    expect(FORWARDED_UPDATE_SIGNALS).toContain('SIGTERM')
    expect(FORWARDED_UPDATE_SIGNALS).toContain('SIGHUP')
    expect(FORWARDED_UPDATE_SIGNALS).toContain('SIGBREAK')
  })
})

describe('hive cli', () => {
  test('documents the uncommon default runtime port', () => {
    expect(DEFAULT_HIVE_PORT).toBe(9483)
    expect(HIVE_USAGE).toContain('default: 9483')
  })

  test('explains Windows EACCES bind failures as possible excluded port ranges', () => {
    const message = formatPortAccessDeniedMessage(3000, 'win32')

    expect(message).toContain('Windows denied access')
    expect(message).toContain('netsh int ipv4 show excludedportrange protocol=tcp')
    expect(message).toContain('hive --port 49152')
  })

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

  test('requests the default port and serves HTTP without requiring that fixed port to be free', async () => {
    const listen = Server.prototype.listen
    const requested: unknown[][] = []
    const boundServers: Server[] = []
    // Record the real CLI's bind request, then let the OS choose an isolated port.
    // Keep the HTTP server, SQLite and lifecycle real; never stop the user's Hive.
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args) {
      requested.push(args)
      boundServers.push(this)
      return Reflect.apply(listen, this, [0, '127.0.0.1'])
    })
    const result = await runHiveCommand([])
    try {
      expect(requested).toEqual([[DEFAULT_HIVE_PORT, '127.0.0.1']])
      expect(boundServers).toHaveLength(1)
      const boundServer = boundServers[0]
      if (!boundServer) throw new Error('CLI did not bind an HTTP server')
      expect(boundServer.address()).toMatchObject({
        address: '127.0.0.1',
        port: result.port,
      })
      expect(result.port).toBeGreaterThan(0)
      const response = await fetch(`http://127.0.0.1:${result.port}/api/ui/session`)
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toMatch(
        /^hive_ui_token=[^;]+; Path=\/; HttpOnly; SameSite=Strict$/
      )
      expect(await response.json()).toEqual({ ok: true })
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
          install_source: 'npm-global',
          latest_version: '0.6.0-alpha.4',
          package_name: '@tt-a1i/hive',
          release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          can_run_hive_update: true,
          update_note: 'Hive appears to be installed through npm.',
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

  test('prints update availability without a command when the install source is unknown', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'], {
      versionService: {
        getVersionInfo: async () => ({
          current_version: '0.6.0-alpha.3',
          install_hint: '',
          install_source: 'unknown',
          latest_version: '0.6.0-alpha.4',
          package_name: '@tt-a1i/hive',
          release_url: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          can_run_hive_update: false,
          update_note:
            'Hive could not determine how this process was installed; update it with the same package manager and install target you originally used.',
          update_available: true,
        }),
      },
    })

    try {
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(
          'Hive update available: 0.6.0-alpha.3 -> 0.6.0-alpha.4. Hive could not determine how this process was installed; update it with the same package manager and install target you originally used.'
        )
      })
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Run: npm install -g @tt-a1i/hive@latest')
      )
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

  test('reports success only after the target passes real SQLite and PTY probes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ command: string; args: string[] }> = []
    const install = createNpmGlobalInstallModuleUrl()
    symlinkSync(
      realpathSync('node_modules'),
      join(install.prefix, 'node_modules/@tt-a1i/hive/node_modules'),
      'junction'
    )
    symlinkSync(
      realpathSync('dist/src/server'),
      join(install.prefix, 'node_modules/@tt-a1i/hive/dist/src/server'),
      'junction'
    )
    const runUpdate: RunUpdate = async (command, args) => {
      calls.push({ command, args: [...args] })
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand([], {
      env: {},
      moduleUrl: install.moduleUrl,
      runUpdate,
    })

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install', '-g', '@tt-a1i/hive@latest', ignoreScripts, '--prefix', install.prefix],
      },
    ])
    expect(logSpy).toHaveBeenCalledWith(
      `Running: npm install -g @tt-a1i/hive@latest ${ignoreScripts} --prefix ${process.platform === 'win32' ? `"${install.prefix}"` : install.prefix}`
    )
    expect(logSpy).toHaveBeenCalledWith(
      'Hive updated. Restart any running Hive process to pick up the new version.'
    )
  })

  test('rejects npm exit zero when the target has no native dependencies', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const install = createNpmGlobalInstallModuleUrl()

    const code = await runHiveUpdateCommand([], {
      env: {},
      moduleUrl: install.moduleUrl,
      runUpdate: async () => ({ exitCode: 0 }),
    })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'npm install finished, but the install target failed native verification.'
    )
    expect(logSpy).not.toHaveBeenCalledWith(
      'Hive updated. Restart any running Hive process to pick up the new version.'
    )
  })

  test('updates the same npm prefix as the active Hive install', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'hive-update-prefix-'))
    try {
      const packageRoot = join(prefix, 'lib/node_modules/@tt-a1i/hive')
      const cliDir = join(packageRoot, 'dist/src/cli')
      mkdirSync(cliDir, { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tt-a1i/hive' }))

      const moduleUrl = pathToFileURL(join(cliDir, 'hive-update.js')).href

      expect(resolveHiveUpdateInstallArgs(moduleUrl)).toEqual([
        'install',
        '-g',
        '@tt-a1i/hive@latest',
        ignoreScripts,
        '--prefix',
        prefix,
      ])
    } finally {
      rmSync(prefix, { recursive: true, force: true })
    }
  })

  test('formats Windows update commands with quoted space-bearing prefixes', () => {
    const args = [
      'install',
      '-g',
      '@tt-a1i/hive@latest',
      ignoreScripts,
      '--prefix',
      'C:\\Hive Tools',
    ]
    expect(formatUpdateCommand('npm', args, 'win32')).toBe(
      `npm install -g @tt-a1i/hive@latest ${ignoreScripts} --prefix "C:\\Hive Tools"`
    )
  })

  test('non-zero npm exit propagates the code, prints an error, and offers the manual fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const install = createNpmGlobalInstallModuleUrl()
    const runUpdate: RunUpdate = async () => ({ exitCode: 7 })

    const code = await runHiveUpdateCommand([], {
      env: {},
      moduleUrl: install.moduleUrl,
      runUpdate,
    })

    expect(code).toBe(7)
    expect(errorSpy).toHaveBeenCalledWith('npm install exited with code 7.')
    // EACCES / sudo-required installs land here; the recovery hint must be
    // surfaced on this path too, not only on spawn ENOENT.
    expect(errorSpy).toHaveBeenCalledWith(
      `You can run the upgrade manually: npm install -g @tt-a1i/hive@latest ${ignoreScripts} --prefix ${process.platform === 'win32' ? `"${install.prefix}"` : install.prefix}`
    )
  })

  test('spawn error (npm not on PATH) exits 1 and surfaces the manual fallback hint', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const install = createNpmGlobalInstallModuleUrl()
    const runUpdate: RunUpdate = async () => ({
      exitCode: 1,
      spawnError: new Error('spawn npm ENOENT'),
    })

    const code = await runHiveUpdateCommand([], {
      env: {},
      moduleUrl: install.moduleUrl,
      runUpdate,
    })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn npm: spawn npm ENOENT')
    expect(errorSpy).toHaveBeenCalledWith(
      `You can run the upgrade manually: npm install -g @tt-a1i/hive@latest ${ignoreScripts} --prefix ${process.platform === 'win32' ? `"${install.prefix}"` : install.prefix}`
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

  test('refuses to shadow a pnpm install with a new npm global copy', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }
    const root = mkdtempSync(join(tmpdir(), 'hive-update-pnpm-'))
    try {
      const packageRoot = join(
        root,
        'global/5/node_modules/.pnpm/@tt-a1i+hive@2.1.2/node_modules/@tt-a1i/hive'
      )
      const cliDir = join(packageRoot, 'dist/src/cli')
      mkdirSync(cliDir, { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tt-a1i/hive' }))
      const moduleUrl = pathToFileURL(join(cliDir, 'hive-update.js')).href

      const code = await runHiveUpdateCommand([], { moduleUrl, runUpdate })

      expect(code).toBe(1)
      expect(runUpdateInvoked).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith(
        'hive update cannot safely update a pnpm-global install.'
      )
      expect(errorSpy).toHaveBeenCalledWith('Run manually: pnpm add -g @tt-a1i/hive@latest')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('unknown install source does not offer an npm global fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }
    const root = mkdtempSync(join(tmpdir(), 'hive-update-unknown-'))
    try {
      const moduleUrl = pathToFileURL(join(root, 'dist/src/cli/hive-update.js')).href

      const code = await runHiveUpdateCommand([], { env: {}, moduleUrl, runUpdate })

      expect(code).toBe(1)
      expect(runUpdateInvoked).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith('hive update cannot safely update a unknown install.')
      expect(errorSpy).toHaveBeenCalledWith(
        'Hive could not determine how this process was installed; update it with the same package manager and install target you originally used.'
      )
      expect(errorSpy).not.toHaveBeenCalledWith('Run manually: npm install -g @tt-a1i/hive@latest')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('planSpawnInvocation wraps .cmd / .bat shims through cmd.exe on win32 — without shell:true', () => {
    // shell:true was the historical workaround for Node 22+'s refusal to
    // spawn .cmd/.bat after CVE-2024-27980, but it joins argv into a
    // single string that cmd.exe then word-splits. An --prefix path
    // containing spaces (e.g. `C:\Program Files\nodejs`) got tokenized
    // mid-path and npm installed hive to the wrong directory. Wrapping
    // through cmd.exe requires cmd quoting and verbatim arguments;
    // Node's default CRT quoting would backslash-escape those quotes.
    const plan = planSpawnInvocation(
      'npm.cmd',
      ['install', '-g', '--prefix', 'C:\\Program Files\\nodejs', '@tt-a1i/hive'],
      'win32'
    )
    expect(plan.command).toBe('cmd.exe')
    expect(plan.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"call npm.cmd install -g --prefix "C:\\Program Files\\nodejs" @tt-a1i/hive"',
    ])
    expect(plan.options.windowsVerbatimArguments).toBe(true)
    expect((plan.options as { shell?: boolean }).shell).not.toBe(true)
  })

  test('planSpawnInvocation handles .CMD and .bat with the same wrap (extension match is case-insensitive)', () => {
    expect(planSpawnInvocation('npm.CMD', ['x'], 'win32').command).toBe('cmd.exe')
    expect(planSpawnInvocation('npm.bat', ['x'], 'win32').command).toBe('cmd.exe')
  })

  test('planSpawnInvocation escapes cmd metachars and percent signs in .cmd args', () => {
    const plan = planSpawnInvocation('npm.cmd', ['install', 'C:\\Users\\%USERNAME%\\a&b'], 'win32')
    expect(plan.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"call npm.cmd install "C:\\Users\\%%USERNAME%%\\a&b""',
    ])
  })

  test('planSpawnInvocation passes native binaries straight through with no wrap', () => {
    const plan = planSpawnInvocation('npm', ['install', '-g'], 'linux')
    expect(plan.command).toBe('npm')
    expect(plan.args).toEqual(['install', '-g'])
  })

  test('planSpawnInvocation does not wrap a .cmd on POSIX — only the win32 branch needs the cmd.exe shim', () => {
    // Defensive: a tester accidentally invoking `npm.cmd` on macOS should
    // not silently get a cmd.exe spawn (which would ENOENT noisily and
    // hide the real configuration error).
    const plan = planSpawnInvocation('npm.cmd', ['x'], 'darwin')
    expect(plan.command).toBe('npm.cmd')
  })

  test('killUpdateChild on win32 walks the process tree via taskkill — child.kill is only the fallback', () => {
    // On Windows there are no real signals; child.kill(SIGTERM) resolves
    // to TerminateProcess against the wrapper cmd.exe alone, orphaning
    // npm and its install scripts. taskkill /pid <pid> /t /f walks the
    // tree (parent-up-to-children) so the whole branch dies together.
    const killTreeCalls: number[] = []
    const childKillCalls: NodeJS.Signals[] = []
    const child = {
      pid: 12345,
      kill: (signal: NodeJS.Signals) => {
        childKillCalls.push(signal)
        return true
      },
    }
    killUpdateChild(child, 'SIGINT', 'win32', (pid) => {
      killTreeCalls.push(pid)
      return true
    })
    expect(killTreeCalls).toEqual([12345])
    expect(childKillCalls).toEqual([])
  })

  test('killUpdateChild falls back to child.kill when taskkill fails on win32', () => {
    // taskkill can fail if it's missing from PATH or the system policy
    // blocks it. The wrapper at least needs to die so the parent's wait
    // unblocks — orphans are bad but a hung parent is worse.
    const childKillCalls: NodeJS.Signals[] = []
    const child = {
      pid: 9999,
      kill: (signal: NodeJS.Signals) => {
        childKillCalls.push(signal)
        return true
      },
    }
    killUpdateChild(child, 'SIGTERM', 'win32', () => false)
    expect(childKillCalls).toEqual(['SIGTERM'])
  })

  test('killUpdateChild falls back when async taskkill reports failure after launch', () => {
    const childKillCalls: NodeJS.Signals[] = []
    let taskkillFailure: (() => void) | undefined
    const child = {
      pid: 9999,
      kill: (signal: NodeJS.Signals) => {
        childKillCalls.push(signal)
        return true
      },
    }
    killUpdateChild(child, 'SIGHUP', 'win32', (_pid, onFailure) => {
      taskkillFailure = onFailure
      return true
    })
    expect(childKillCalls).toEqual([])
    taskkillFailure?.()
    expect(childKillCalls).toEqual(['SIGHUP'])
  })

  test('killUpdateChild on POSIX hands the signal straight to child.kill — no tree walk', () => {
    // Linux/macOS already inherit the controlling terminal's signal
    // broadcast to the whole process group, and child.kill(signal) on
    // POSIX sends a real signal that npm honors. No taskkill needed.
    const killTreeCalls: number[] = []
    const childKillCalls: NodeJS.Signals[] = []
    const child = {
      pid: 4321,
      kill: (signal: NodeJS.Signals) => {
        childKillCalls.push(signal)
        return true
      },
    }
    killUpdateChild(child, 'SIGINT', 'linux', (pid) => {
      killTreeCalls.push(pid)
      return true
    })
    expect(killTreeCalls).toEqual([])
    expect(childKillCalls).toEqual(['SIGINT'])
  })

  test.each([
    ['win32', 'npm.cmd'],
    ['darwin', 'npm'],
    ['linux', 'npm'],
  ] as const)('selects the npm executable for %s', (platform, command) => {
    expect(getNpmCommand(platform)).toBe(command)
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
    const tsxCli = join(dirname(nodeRequire.resolve('tsx')), 'cli.mjs')
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, 'src/cli/hive.ts', 'update', '--help'], {
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
    expect(result.stdout).toContain(
      `For npm installs, this runs \`npm install -g @tt-a1i/hive@latest ${ignoreScripts}\``
    )
    expect(result.stdout).toContain('hive update')
    // Update help must NOT print the generic `hive` usage with `--port`.
    expect(result.stdout).not.toContain('--port <port>')
  })
})
