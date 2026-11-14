#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { readPackageVersion } from '../server/package-version.js'
import { sameFilesystemPath } from '../server/path-canonicalization.js'
import { createRemoteConfigSource } from '../server/remote-config-keys.js'
import {
  createRemoteTunnel,
  type RemoteTunnel,
  type RemoteTunnelDeps,
} from '../server/remote-tunnel.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'
import { createVersionService, type VersionService } from '../server/version-service.js'
import { resolveDataDir } from './hive-data-dir.js'
import { DEFAULT_HIVE_PORT } from './hive-defaults.js'
import { runHiveRemoteCommand } from './hive-remote.js'
import { runHiveUpdateCommand } from './hive-update.js'

interface RunHiveCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
  /** The remote-access tunnel. Gated by remote_enabled (default OFF); off => no outbound socket. */
  tunnel: RemoteTunnel
}

type RunHiveCommandOptions = {
  versionService?: VersionService
  /** Seam: override the tunnel factory in tests. Defaults to the real createRemoteTunnel. */
  createRemoteTunnel?: (deps: RemoteTunnelDeps) => RemoteTunnel
  /** Auto-open the UI in the default browser once listening. Only the real
   *  CLI entry sets this (with `--no-open` as the opt-out); programmatic
   *  callers and tests default to no browser. */
  openBrowser?: boolean
}

type ListenError = Error & {
  address?: string
  code?: string
  port?: number
}

/**
 * Signals that should drive a graceful shutdown. The interesting ones:
 *
 *   SIGINT  — Ctrl+C in the runtime terminal (all platforms).
 *   SIGTERM — `kill <pid>` on POSIX. Never delivered on Windows.
 *   SIGHUP  — POSIX: parent shell exits. On Windows libuv synthesises
 *             SIGHUP from `CTRL_CLOSE_EVENT`, i.e. the user clicking
 *             the X on the runtime's cmd / Terminal window. Without
 *             this listener that close path skips the graceful path
 *             entirely on Windows.
 *   SIGBREAK — Windows: Ctrl+Break. Less common than Ctrl+C but kit
 *             scripts and CI hosts still send it.
 *
 * Stale agent_runs from a non-graceful exit are reconciled at next
 * startup via `agentRunStore.markUnfinishedRunsStale()`
 * (runtime-store-helpers.ts), so a dropped signal does not leave the
 * database in an inconsistent state — only the PTY children miss the
 * forwarded SIGTERM. On Windows there's no graceful equivalent for
 * those children anyway (pty.kill is TerminateProcess), so this
 * registration is mostly about giving SQLite a chance to checkpoint.
 */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const
export { resolveDataDir } from './hive-data-dir.js'
export { DEFAULT_HIVE_PORT }

export const HIVE_USAGE = [
  'Usage:',
  '  hive [--port <port>] [--no-open]',
  '  hive update',
  '',
  'Options:',
  `  --port <port>   Bind the local runtime to a specific port (default: ${DEFAULT_HIVE_PORT}).`,
  '  --no-open       Do not auto-open the browser after start.',
  '  -h, --help      Print this help.',
  '  -v, --version   Print the installed Hive version.',
  '',
  'Commands:',
  '  update          Upgrade npm-installed Hive in place; otherwise use the matching package manager.',
  '  remote          Manage remote access (login / status / logout / devices / revoke).',
].join('\n')

export const handleHiveInfoCommand = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_USAGE)
    return true
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readPackageVersion())
    return true
  }
  return false
}

const parsePort = (argv: string[]) => {
  let parsedPort: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--port') {
      if (arg === '--no-open') continue // consumed by the CLI entry's openBrowser gate
      if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      if (arg) throw new Error(`Unknown argument: ${arg}`)
      continue
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error('Usage: hive [--port <port>]')
    }

    const port = Number(value)
    if (!/^\d+$/.test(value) || port > 65535) {
      throw new Error(`Invalid port: ${value}`)
    }

    parsedPort = port
    index += 1
  }

  return parsedPort ?? DEFAULT_HIVE_PORT
}

const maybePrintUpdateHint = async (versionService: VersionService) => {
  const info = await versionService.getVersionInfo()
  if (!info.update_available) return
  if (!info.install_hint) {
    console.log(
      `Hive update available: ${info.current_version} -> ${info.latest_version}. ${info.update_note}`
    )
    return
  }
  console.log(
    `Hive update available: ${info.current_version} -> ${info.latest_version}. Run: ${info.install_hint}`
  )
}

const isListenError = (error: unknown): error is ListenError =>
  error instanceof Error && typeof (error as ListenError).code === 'string'

/**
 * Recovery hint formatter for the "port already in use" error. Platform-aware
 * because the lsof / xargs / kill pipeline is POSIX-only; on Windows a user
 * pasting that command into cmd or PowerShell gets nothing useful. The
 * Windows path swaps in `netstat -ano | findstr` + `taskkill /F /PID` which
 * is the documented Microsoft workflow for the same problem.
 *
 * Exported for unit testing.
 */
export const formatPortInUseMessage = (
  port: number,
  platform: NodeJS.Platform = process.platform
) => {
  const stopHint =
    platform === 'win32'
      ? [
          '  - Stop the process using that port:',
          `      netstat -ano | findstr ":${port}"`,
          '      taskkill /PID <pid> /F',
        ]
      : [
          '  - Stop the process using that port:',
          `      lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`,
        ]
  return [
    `Hive could not start because port ${port} is already in use.`,
    '',
    'Another Hive instance may already be running:',
    `  http://127.0.0.1:${port}`,
    '',
    'Options:',
    '  - Open the existing Hive window.',
    ...stopHint,
    '  - Start Hive on another port:',
    `      hive --port ${port === 65535 ? 65534 : port + 1}`,
  ].join('\n')
}

export const formatPortAccessDeniedMessage = (
  port: number,
  platform: NodeJS.Platform = process.platform
) => {
  if (platform !== 'win32') {
    return `Hive could not start on port ${port}: permission denied.`
  }

  return [
    `Hive could not start on port ${port}: Windows denied access to that port.`,
    '',
    'This can happen when Hyper-V, Docker Desktop, WSL2, or Windows itself reserves a TCP port range.',
    '',
    'Check reserved ranges:',
    '  netsh int ipv4 show excludedportrange protocol=tcp',
    '',
    'Options:',
    '  - Start Hive on a high unreserved port:',
    '      hive --port 49152',
    '  - Or choose another port outside the listed excluded ranges.',
  ].join('\n')
}

/* Best-effort default-browser launch. Failure must never affect the runtime:
   the URL is already printed, so a missing opener (e.g. no xdg-open on a
   headless box) silently degrades to the manual copy-paste flow. */
const openUrlInBrowser = (url: string) => {
  const child =
    process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : process.platform === 'win32'
        ? // `start` is a cmd built-in; the empty '' is its window-title slot so
          // the URL is not mistaken for a title.
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

const formatListenError = (error: unknown, requestedPort: number) => {
  if (isListenError(error) && error.code === 'EADDRINUSE') {
    return new Error(formatPortInUseMessage(error.port ?? requestedPort))
  }
  if (isListenError(error) && error.code === 'EACCES') {
    return new Error(formatPortAccessDeniedMessage(error.port ?? requestedPort))
  }
  return error
}

export const runHiveCommand = async (
  argv: string[],
  options: RunHiveCommandOptions = {}
): Promise<RunHiveCommandResult> => {
  const port = parsePort(argv)
  const dataDir = resolveDataDir()
  const versionService = options.versionService ?? createVersionService()
  let boundPort = ''
  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
      getHivePort: () => boundPort,
    }),
    versionService,
  })

  try {
    app.server.listen(port, '127.0.0.1')
    await Promise.race([
      once(app.server, 'listening'),
      once(app.server, 'error').then(([error]) => {
        throw error
      }),
    ])
  } catch (error) {
    await app.store.close()
    throw formatListenError(error, port)
  }

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  boundPort = String(address.port)

  // Remote tunnel — the outbound WebSocket to the gateway. GATED by app_state[remote_enabled]
  // (default OFF). When off, refresh() settles 'disabled' synchronously: no socket is opened, no
  // timer is armed, no listener is added, and the per-boot secret accept path stays inert (a request
  // with no secret header hits the unchanged cookie path). This is invariant 4 — off == zero
  // behavior change. Loopback requests authenticate via the per-boot internal secret (invariant 2),
  // so the bridge never juggles browser cookies.
  const tunnelFactory = options.createRemoteTunnel ?? createRemoteTunnel
  const tunnel = tunnelFactory({
    loopbackPort: address.port,
    config: createRemoteConfigSource({
      get: (key) => app.store.settings.getAppState(key),
    }),
    deviceSessions: app.store.getRemoteDeviceSessions(),
    loopbackSecret: app.store.getRemoteTunnelSecret(),
    audit: app.store.getRemoteAuditStore(),
    // The pairing engine — the tunnel carries pairing TEXT frames alongside the binary data plane and
    // drives the daemon handshake half + the desktop-confirm sequence (gateway register + confirmed).
    pairing: app.store.getRemotePairing(),
    // Capture status so GET /api/remote/status.connected reflects the live tunnel (M4).
    onStatus: (e) => app.store.setRemoteTunnelStatus(e.status),
  })
  // Bind the tunnel onto the store BEFORE refresh() so a revoke route fired during boot can close a
  // device's live streams (the §6 closed loop). The provider-drop half is independent of binding.
  app.store.bindRemoteTunnel(tunnel)
  // refresh() reconciles desired (config) vs actual (socket). Disabled => settles immediately.
  tunnel.refresh()

  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closePromise) {
      return closePromise
    }

    closePromise = (async () => {
      for (const signal of SHUTDOWN_SIGNALS) {
        process.off(signal, gracefulShutdown)
      }
      // Close the outbound tunnel FIRST so it stops reconnecting and tears down its in-flight
      // loopback streams before we rip the inbound WS layer out from under them. Graceful: no status
      // churn, hard-terminate after a short grace.
      await tunnel.close()
      // Tear down the WebSocket layer FIRST. `app.server.close()` waits
      // on every existing socket, including upgraded WebSocket clients
      // that never go idle on their own; `server.closeAllConnections()`
      // alone does NOT terminate already-upgraded WS — only sockets
      // still in the HTTP request/response state machine. The Windows
      // symptom of skipping this step is Ctrl+C in the runtime cmd
      // window hanging the process as long as any browser tab is
      // connected to /ws/terminal/<runId> or /ws/tasks/<workspaceId>.
      app.closeWebSockets()
      // Then force-close any remaining plain-HTTP keep-alive sockets.
      app.server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      await app.store.close()
    })()

    return closePromise
  }

  const gracefulShutdown = () => {
    void close()
      .then(() => {
        process.exit(0)
      })
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, gracefulShutdown)
  }

  const url = `http://127.0.0.1:${address.port}`
  console.log(`Hive running at ${url}`)
  if (options.openBrowser === true && !argv.includes('--no-open')) {
    openUrlInBrowser(url)
  }
  void maybePrintUpdateHint(versionService).catch(() => {})

  return {
    port: address.port,
    close,
    store: app.store,
    tunnel,
  }
}

export type { RunHiveCommandResult }

const isMainModule = process.argv[1]
  ? sameFilesystemPath(fileURLToPath(import.meta.url), process.argv[1])
  : false

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'update') {
    runHiveUpdateCommand(argv.slice(1))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  } else if (argv[0] === 'remote') {
    runHiveRemoteCommand(argv.slice(1))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
      })
  } else if (handleHiveInfoCommand(argv)) {
    process.exit(0)
  } else {
    runHiveCommand(argv, { openBrowser: true }).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  }
}
