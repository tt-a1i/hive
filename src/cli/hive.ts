#!/usr/bin/env node

import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'

interface RunHiveCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
}

const parsePort = (argv: string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--port') {
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

    return port
  }

  return 3000
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
  runHiveCommand(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
