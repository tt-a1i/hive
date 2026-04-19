import '../helpers/mock-node-pty.ts'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const stores: Array<{ close: () => Promise<void> }> = []

const waitFor = async (assertion: () => void, timeoutMs = 1500, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('worker restart status (unit)', () => {
  test('starting a stopped worker restores non-stopped team status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-restart-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'exit-immediately.js')
    writeFileSync(scriptPath, 'process.exit(0)\n')

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [scriptPath],
    })

    const firstRun = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    await waitFor(() => {
      expect(store.getLiveRun(firstRun.runId).status).toBe('exited')
      expect(store.listWorkers(workspace.id)).toContainEqual(
        expect.objectContaining({ id: worker.id, status: 'stopped' })
      )
    })

    const secondRun = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    expect(store.getLiveRun(secondRun.runId).status).toBe('starting')
    expect(store.listWorkers(workspace.id)).not.toContainEqual(
      expect.objectContaining({ id: worker.id, status: 'stopped' })
    )
  })
})
