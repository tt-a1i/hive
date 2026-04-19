import { once } from 'node:events'

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

export const runHiveCommand = async (argv: string[]): Promise<RunHiveCommandResult> => {
  const port = parsePort(argv)
  const dataDir = process.env.HIVE_DATA_DIR
  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      ...(dataDir ? { dataDir } : {}),
    }),
  })

  app.server.listen(port, '127.0.0.1')
  await once(app.server, 'listening')

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
      await app.store.close()
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
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
