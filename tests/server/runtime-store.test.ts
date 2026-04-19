import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const tempDirs: string[] = []
const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const createFakeAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunSnapshot>()

  return {
    getOutputBus() {
      return outputBus
    },
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const run = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1,
        runId: `run-${input.agentId}`,
        status: 'starting' as const,
      }
      runs.set(run.runId, run)
      return run
    },
    stopRun() {},
    writeInput() {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('runtime store', () => {
  test('can create workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(workspace).toMatchObject({
      name: 'Alpha',
      path: '/tmp/hive-alpha',
    })
  })

  test('createWorkspace does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-create-workspace-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workspaces')) {
        throw new Error('insert workspace failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')).toThrow(
      /insert workspace failed/
    )
    expect(workspaceStore.listWorkspaces()).toEqual([])

    db.close()
  })

  test('each workspace automatically has one orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const snapshot = store.getWorkspaceSnapshot(workspace.id)

    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      name: 'Orchestrator',
      role: 'orchestrator',
      status: 'idle',
      pendingTaskCount: 0,
    })
  })

  test('can add worker', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(worker).toMatchObject({
      workspaceId: workspace.id,
      name: 'Alice',
      role: 'coder',
      status: 'stopped',
      pendingTaskCount: 0,
    })
  })

  test('dispatchTask increments worker pending count and marks it working', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('working')
  })

  test('startAgent success promotes a fresh worker from stopped to idle', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })

  test('startAgent success keeps a queued worker in working', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    expect(store.getWorker(workspace.id, worker.id).status).toBe('working')
  })

  test('reportTask resets worker pending count and returns it to idle', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('idle')
  })

  test('reportTask keeps a stopped worker stopped while draining pending count', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.getWorker(workspace.id, worker.id).status = 'stopped'
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('listWorkers excludes orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.addWorker(workspace.id, {
      name: 'Bob',
      role: 'tester',
    })

    expect(store.listWorkers(workspace.id)).toEqual([
      {
        id: expect.any(String),
        name: 'Alice',
        role: 'coder',
        status: 'stopped',
        pendingTaskCount: 0,
      },
      {
        id: expect.any(String),
        name: 'Bob',
        role: 'tester',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('rejects duplicate worker names within the same workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('addWorker does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-add-worker-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workers')) {
        throw new Error('insert worker failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })).toThrow(
      /insert worker failed/
    )
    expect(workspaceStore.listWorkers(workspace.id)).toEqual([])

    db.close()
  })
})
