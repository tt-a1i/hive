import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startAgent exception rollback (R1.2)', () => {
  test('marks agent stopped when launch config is missing', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-rollback', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      /Agent launch config not found/
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
  })

  test('worker lands in stopped (§12) when the spawned command does not exist', async () => {
    const store = createRuntimeStore({ agentManager: createAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-bad-spawn', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/definitely/not/a/real/binary',
      args: [],
    })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      '/definitely/not/a/real/binary CLI not found in PATH'
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    expect(store.peekAgentToken(worker.id)).toBeUndefined()
    expect(store.listAgentRuns(worker.id)).toEqual([])
  })

  test('marks agent stopped when agentManager.startAgent throws after token issue', async () => {
    const agentManager = createAgentManager()
    const spawnError = new Error('simulated spawn failure')
    const originalStart = agentManager.startAgent.bind(agentManager)
    vi.spyOn(agentManager, 'startAgent').mockImplementation(async (input) => {
      // Allow mock flow; we just throw to simulate a failure after env/token construction.
      void originalStart
      void input
      throw spawnError
    })

    const store = createRuntimeStore({ agentManager })
    const workspace = store.createWorkspace('/tmp/hive-rollback-spawn', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      /simulated spawn failure/
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    // Token must not linger after a failed start.
    expect(store.peekAgentToken(worker.id)).toBeUndefined()
  })
})
