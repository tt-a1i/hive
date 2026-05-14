#!/usr/bin/env node

import { once } from 'node:events'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'

interface RunHiveCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
}

export const HIVE_USAGE = [
  'Usage:',
  '  hive [--port <port>]',
  '',
  'Options:',
  '  --port <port>   Bind the local runtime to a specific port (default: 3000).',
  '  -h, --help      Print this help.',
  '  -v, --version   Print the installed Hive version.',
].join('\n')

const readPackageVersion = () => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string') return parsed.version
    }
    dir = dirname(dir)
  }
  return 'unknown'
}

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
      if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      if (arg) throw new Error(`Unknown argument: ${arg}`)
      continue
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error('Usage: hive [--port <port>]')
    }

    const port = Number.parseInt(value, 10)
    if (Number.isNaN(port) || port < 0) {
      throw new Error(`Invalid port: ${value}`)
    }

    parsedPort = port
    index += 1
  }

  return parsedPort ?? 3000
}

const resolveDataDir = () => process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'hive')

export const runHiveCommand = async (argv: string[]): Promise<RunHiveCommandResult> => {
  const port = parsePort(argv)
  const dataDir = resolveDataDir()
  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    }),
  })

  app.server.listen(port, '127.0.0.1')
  await Promise.race([
    once(app.server, 'listening'),
    once(app.server, 'error').then(([error]) => {
      throw error
    }),
  ])

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closePromise) {
      return closePromise
    }

    closePromise = (async () => {
      process.off('SIGTERM', gracefulShutdown)
      process.off('SIGINT', gracefulShutdown)
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

  process.once('SIGTERM', gracefulShutdown)
  process.once('SIGINT', gracefulShutdown)

  console.log(`Hive running at http://127.0.0.1:${address.port}`)

  return {
    port: address.port,
    close,
    store: app.store,
  }
}

export type { RunHiveCommandResult }

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (handleHiveInfoCommand(argv)) process.exit(0)
  runHiveCommand(argv).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
