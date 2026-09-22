import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { probeDirectory } from '../../src/server/fs-browse.js'
import type { PickFolderResponse } from '../../src/server/fs-pick-folder.js'
import type { OpenWorkspaceService } from '../../src/server/route-types.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from './fs-cleanup.js'

interface TestServerContext {
  baseUrl: string
  close: () => Promise<void>
  dataDir: string
  store: ReturnType<typeof createRuntimeStore>
}

export const startTestServer = async (
  input: {
    dataDir?: string
    openWorkspaceService?: OpenWorkspaceService
    pickFolderPath?: string
    pickFolderService?: () => Promise<PickFolderResponse>
  } = {}
): Promise<TestServerContext> => {
  const ownsDataDir = !input.dataDir
  const dataDir = input.dataDir ?? mkdtempSync(join(tmpdir(), 'hive-test-server-'))
  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  const pickFolderService =
    input.pickFolderService ??
    (input.pickFolderPath
      ? async () => ({
          canceled: false,
          error: null,
          path: input.pickFolderPath ?? null,
          probe: input.pickFolderPath ? await probeDirectory(input.pickFolderPath) : null,
          supported: true,
        })
      : undefined)
  const app = createApp({
    ...(input.openWorkspaceService ? { openWorkspaceService: input.openWorkspaceService } : {}),
    ...(pickFolderService ? { pickFolderService } : {}),
    store,
  })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      app.closeWebSockets()
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      if (ownsDataDir) removeTestPath(dataDir)
    },
    dataDir,
    store,
  }
}
