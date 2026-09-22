import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { taskkillProcessTree } from '../server/agent-manager-support.js'
import { buildSpawnPathEnvEntry } from '../server/agent-run-bootstrap.js'
import {
  getNpmCommand,
  INSTALL_COMMAND_DISPLAY,
  PACKAGE_NAME,
  readPackageVersion,
} from '../server/package-version.js'
import {
  buildVersionLockedInstallCommand,
  createUpdateInstallPlan,
  findPackageRoot,
  formatUpdateCommand,
} from '../server/update-install-plan.js'
import { buildCmdCallCommand } from '../server/windows-command-line.js'

const NATIVE_VERIFY_TIMEOUT_MS = 10_000

export const HIVE_UPDATE_USAGE = [
  'Usage:',
  '  hive update',
  '',
  'Upgrades npm-installed Hive in place.',
  `For npm installs, this runs \`${INSTALL_COMMAND_DISPLAY}\`.`,
  'Installation scripts are disabled; Hive ships ready-to-use runtime dependencies.',
  'When Hive was installed under a custom npm prefix, the update is applied',
  'to that same prefix so the `hive` on your PATH actually changes.',
  'After npm exits 0, hive update probes SQLite and a short-lived PTY at the',
  'install target using this Hive CLI Node. Failure is not reported as a',
  'successful update. The npm child gets that Node directory prepended on PATH',
  'for this process only; the install prefix stays a package target.',
  'Restart any running Hive process afterwards to pick up the new version.',
  '',
  'Note: only npm-installed Hive can be upgraded this way. If you installed',
  'Hive via pnpm or yarn, upgrade through the same package manager instead;',
  'otherwise the npm copy will shadow your existing install.',
  '',
  'Options:',
  '  -h, --help      Print this help.',
].join('\n')

export interface RunUpdateResult {
  exitCode: number
  spawnError?: Error
}

export type RunUpdate = (command: string, args: readonly string[]) => Promise<RunUpdateResult>

export interface SpawnInvocationPlan {
  command: string
  args: string[]
  options: { stdio: 'inherit'; windowsHide?: boolean; windowsVerbatimArguments?: boolean }
}

/**
 * Plan how `defaultRunUpdate` should hand the npm invocation to
 * `child_process.spawn`. Two non-obvious cases collapse here.
 *
 * 1. Node 22+ refuses to spawn `.cmd` / `.bat` files directly after
 *    CVE-2024-27980 unless `shell: true` is passed. We do not want
 *    `shell: true` though — its arg-stringification path joins argv
 *    without quoting, so an install prefix containing spaces (the
 *    common Windows case `C:\Program Files\nodejs`) gets word-split
 *    by cmd.exe and `--prefix` only sees the first token, so npm
 *    silently installs hive to the wrong directory.
 * 2. Wrapping with `cmd.exe /d /s /c <npm.cmd> <args>` solves both:
 *    spawning `cmd.exe` (a native exe) avoids the .cmd refusal, and
 *    Pass the already cmd-quoted payload verbatim so Node does not
 *    escape its quotes using incompatible CRT backslashes. The outer
 *    quotes are stripped by `/s`. `/d` skips AutoRun and `/s` keeps the
 *    quote-handling consistent with `/c`.
 *
 * Detect by filename suffix instead of `process.platform` so unit
 * tests can inject `platform: 'win32'` and exercise the wrap.
 */
export const planSpawnInvocation = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): SpawnInvocationPlan => {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${buildCmdCallCommand(command, args)}"`],
      options: { stdio: 'inherit', windowsHide: false, windowsVerbatimArguments: true },
    }
  }
  return { command, args: [...args], options: { stdio: 'inherit' } }
}

/**
 * Signals the upgrade child should receive when the parent runtime is
 * interrupted. Beyond the POSIX-only SIGTERM/SIGINT, SIGHUP is what
 * libuv synthesises from Windows CTRL_CLOSE_EVENT (window X close),
 * and SIGBREAK comes from Windows Ctrl+Break. Without forwarding
 * those two the npm child outlives the runtime on the most common
 * Windows exit paths.
 */
export const FORWARDED_UPDATE_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGBREAK',
]

/**
 * Forward a parent-process signal to the spawned npm child. On POSIX
 * we hand the signal straight to the child; on Windows there are no
 * real signals, so `child.kill(SIGTERM)` resolves to TerminateProcess
 * against cmd.exe (our wrapper) only — npm itself, plus any install
 * scripts it spawned, become orphans. `taskkill /pid <pid> /t /f`
 * walks the wrapper's process tree so the whole branch dies together.
 * If taskkill is unavailable (restricted PATH, locked-down policy)
 * we fall back to `child.kill` so the wrapper at least exits.
 *
 * Exported so the win32 path can be unit-tested by injecting a stub
 * `killTree` runner — the real `taskkillProcessTree` shells out, and
 * we don't want that running during the test suite.
 */
export const killUpdateChild = (
  child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  killTree: (pid: number, onFailure?: () => void) => boolean = (pid, onFailure) =>
    taskkillProcessTree(pid, platform, undefined, onFailure)
): void => {
  const fallback = () => {
    try {
      child.kill(signal)
    } catch {
      // child.kill on Windows throws if the signal name isn't
      // implemented; we forward what we can and ignore the rest.
    }
  }
  if (platform === 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    if (killTree(child.pid, fallback)) return
  }
  fallback()
}

/** Same Node directory as this Hive CLI, prepended only for this child. */
const hiveRuntimeEnv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv => ({
  ...env,
  ...buildSpawnPathEnvEntry(env, dirname(process.execPath), platform),
})

export const defaultRunUpdate: RunUpdate = (command, args) =>
  new Promise<RunUpdateResult>((resolve) => {
    const plan = planSpawnInvocation(command, args)
    const child = spawn(plan.command, plan.args, {
      ...plan.options,
      env: hiveRuntimeEnv(process.env, process.platform),
    })
    let resolved = false

    // Handlers are registered with `once` so they don't accumulate
    // across invocations and explicitly removed at finalize().
    const handlers = new Map<NodeJS.Signals, () => void>()
    for (const signal of FORWARDED_UPDATE_SIGNALS) {
      const handler = () => {
        killUpdateChild(child, signal)
      }
      handlers.set(signal, handler)
      process.once(signal, handler)
    }

    const finalize = (result: RunUpdateResult) => {
      if (resolved) return
      resolved = true
      for (const [signal, handler] of handlers) {
        process.off(signal, handler)
      }
      resolve(result)
    }

    child.on('error', (error) => {
      finalize({ exitCode: 1, spawnError: error })
    })
    child.on('close', (code) => {
      finalize({ exitCode: typeof code === 'number' ? code : 1 })
    })
  })

export { resolveHiveUpdateInstallArgs } from '../server/update-install-plan.js'

const NATIVE_VERIFY_OK = 'HIVE_NATIVE_VERIFY_OK'
const NATIVE_PTY_SENTINEL = 'HIVE_NATIVE_PTY_OK'

/** Fresh Node process: resolve SQLite/PTY from the install target, not this process cache. */
const NATIVE_VERIFY_SCRIPT = `
const { createRequire } = require('node:module');
const { join } = require('node:path');
const packageRoot = process.argv[1];
if (!packageRoot) {
  console.error('missing-package-root');
  process.exit(2);
}
const req = createRequire(join(packageRoot, 'package.json'));
const { Database } = req(join(packageRoot, 'dist/src/server/sqlite.js'));
const db = new Database(':memory:');
try {
  const row = db.transaction(() => db.prepare('SELECT 1 AS ok').get())();
  if (!row || row.ok !== 1) {
    console.error('sqlite-probe-failed');
    process.exit(3);
  }
} finally {
  db.close();
}
const { spawn } = req(join(packageRoot, 'dist/src/server/pty.js'));
const sentinel = ${JSON.stringify(NATIVE_PTY_SENTINEL)};
let output = '';
const pty = spawn(process.execPath, ['-e', 'process.stdout.write(${JSON.stringify(NATIVE_PTY_SENTINEL)})'], {
  cols: 80,
  cwd: packageRoot,
  name: 'xterm-256color',
  rows: 24,
});
const timer = setTimeout(() => {
  try { pty.kill(); } catch {}
  console.error('pty-probe-timeout');
  process.exit(4);
}, 8000);
pty.onData((chunk) => { output += chunk.toString(); });
pty.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (!output.includes(sentinel)) {
    console.error('pty-sentinel-missing');
    process.exit(5);
  }
  if (exitCode !== 0) {
    console.error('pty-exit-' + String(exitCode));
    process.exit(6);
  }
  process.stdout.write(${JSON.stringify(NATIVE_VERIFY_OK)});
  process.exit(0);
});
`

const resolveUpdatedInstallTarget = (
  packageRoot: string | undefined,
  prefix: string | undefined
): string | undefined => {
  if (prefix) {
    const candidates = [
      join(prefix, 'lib/node_modules', PACKAGE_NAME),
      join(prefix, 'node_modules', PACKAGE_NAME),
    ]
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return packageRoot
}

export const verifyInstalledNativeRuntime = (
  packageRoot: string,
  runtimeNode: string = process.execPath
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(runtimeNode, ['-e', NATIVE_VERIFY_SCRIPT, packageRoot], {
      env: {
        ...hiveRuntimeEnv(process.env, process.platform),
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      // Windows: killUpdateChild uses taskkill /t. POSIX: SIGKILL this verifier;
      // node-pty master close reaps the slave (darwin: hanging node + sleep both
      // gone at 100ms after parent SIGKILL). No extra process-tree framework.
      killUpdateChild(child, 'SIGKILL')
      finish(new Error(`Native verification timed out for ${packageRoot}`))
    }, NATIVE_VERIFY_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      finish(error)
    })
    child.on('close', (code) => {
      if (code === 0 && stdout.includes(NATIVE_VERIFY_OK)) {
        finish()
        return
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      finish(
        new Error(
          `Native verification failed for ${packageRoot} (exit ${code ?? 'null'})${detail ? `: ${detail}` : ''}`
        )
      )
    })
  })

interface RunHiveUpdateOptions {
  /** Override environment detection for tests. */
  env?: NodeJS.ProcessEnv | undefined
  /** Inject a fake spawn for tests. */
  runUpdate?: RunUpdate
  /** Override platform detection for tests. */
  platform?: NodeJS.Platform
  /** Override the current module URL for install-prefix detection in tests. */
  moduleUrl?: string
}

export const runHiveUpdateCommand = async (
  argv: string[],
  options: RunHiveUpdateOptions = {}
): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_UPDATE_USAGE)
    return 0
  }

  // Reject unknown flags rather than silently ignoring them — keeps behavior
  // consistent with how `parsePort` validates `hive` itself.
  const extra = argv.find((arg) => arg !== '--help' && arg !== '-h')
  if (extra !== undefined) {
    console.error(`Unknown argument: ${extra}`)
    console.error(HIVE_UPDATE_USAGE)
    return 1
  }

  const run = options.runUpdate ?? defaultRunUpdate
  const platform = options.platform ?? process.platform
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const updatePlan = createUpdateInstallPlan({
    env: options.env,
    moduleUrl,
    platform,
  })
  if (!updatePlan.canRunHiveUpdate) {
    console.error(`hive update cannot safely update a ${updatePlan.installSource} install.`)
    console.error(updatePlan.note)
    if (updatePlan.installCommand) {
      console.error(`Run manually: ${updatePlan.installCommand}`)
    }
    return 1
  }

  const prefixIndex = updatePlan.installArgs.indexOf('--prefix')
  const prefix = prefixIndex >= 0 ? updatePlan.installArgs[prefixIndex + 1] : undefined
  if (prefix) {
    try {
      accessSync(prefix, constants.W_OK)
    } catch (error) {
      console.error(`hive update cannot write to the install prefix: ${prefix}`)
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  const args = [...updatePlan.installArgs]
  const command = getNpmCommand(platform)
  const displayCommand = formatUpdateCommand('npm', args, platform)
  console.log(`Running: ${displayCommand}`)

  const result = await run(command, args)

  if (result.spawnError) {
    console.error(`Failed to spawn npm: ${result.spawnError.message}`)
    console.error(`You can run the upgrade manually: ${displayCommand}`)
    return 1
  }

  if (result.exitCode !== 0) {
    console.error(`npm install exited with code ${result.exitCode}.`)
    // Permission failures (EACCES on root-owned /usr/bin/npm) and other
    // non-spawn errors leave the user with copy-paste recovery either way.
    console.error(`You can run the upgrade manually: ${displayCommand}`)
    return result.exitCode
  }

  const packageRoot = resolveUpdatedInstallTarget(findPackageRoot(moduleUrl), prefix)
  const recovery = buildVersionLockedInstallCommand(readPackageVersion(), updatePlan, platform)
  const printRecovery = () => {
    if (recovery) console.error(`Reinstall the same version with: ${recovery}`)
    else {
      console.error(
        'Could not determine a version-locked recovery command. Confirm the original Hive version and install source before reinstalling.'
      )
      console.error(updatePlan.note)
    }
  }
  if (!packageRoot) {
    console.error(
      'npm install finished, but Hive could not locate the install target for native verification.'
    )
    printRecovery()
    return 1
  }
  try {
    await verifyInstalledNativeRuntime(packageRoot, process.execPath)
  } catch (error) {
    console.error('npm install finished, but the install target failed native verification.')
    console.error(error instanceof Error ? error.message : String(error))
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(error.cause.message)
    }
    printRecovery()
    return 1
  }

  console.log('Hive updated. Restart any running Hive process to pick up the new version.')
  return 0
}
