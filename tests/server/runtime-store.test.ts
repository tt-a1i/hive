import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { CODER_ROLE_DESCRIPTION, TESTER_ROLE_DESCRIPTION } from '../../src/server/role-templates.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startReportWorker } from '../helpers/report-worker.js'

const tempDirs: string[] = []
const tinyAvatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
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
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
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
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
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

  test('each workspace automatically has an orchestrator and a workflow pseudo-agent', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const snapshot = store.getWorkspaceSnapshot(workspace.id)

    // Orchestrator + the PTY-less __workflow__ pseudo-agent (hidden from the
    // worker roster, present for workflow dispatch identity).
    expect(snapshot.agents).toHaveLength(2)
    expect(snapshot.agents.map((agent) => agent.role).sort()).toEqual(['orchestrator', 'workflow'])
    expect(snapshot.agents.find((agent) => agent.role === 'orchestrator')).toMatchObject({
      name: 'Orchestrator',
      role: 'orchestrator',
      status: 'stopped',
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

  test('can set and clear worker avatar without changing default workers', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const worker = store.addWorker(workspace.id, {
      avatar: tinyAvatar,
      name: 'Alice',
      role: 'coder',
    })

    expect(worker.avatar).toBe(tinyAvatar)
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ avatar: tinyAvatar, id: worker.id })
    )

    store.updateWorkerAvatar(workspace.id, worker.id, null)

    expect(store.getWorker(workspace.id, worker.id).avatar).toBeUndefined()
    expect(store.listWorkers(workspace.id).find((item) => item.id === worker.id)).toEqual(
      expect.not.objectContaining({ avatar: expect.any(String) })
    )
  })

  test('persists worker avatar across runtime store rehydration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-avatar-'))
    tempDirs.push(dataDir)
    const firstStore = createRuntimeStore({ dataDir })
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, {
      avatar: tinyAvatar,
      name: 'Alice',
      role: 'coder',
    })
    await firstStore.close()

    const secondStore = createRuntimeStore({ dataDir })
    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ avatar: tinyAvatar, id: worker.id })
    )
    secondStore.updateWorkerAvatar(workspace.id, worker.id, null)
    await secondStore.close()

    const thirdStore = createRuntimeStore({ dataDir })
    expect(thirdStore.listWorkers(workspace.id).find((item) => item.id === worker.id)).toEqual(
      expect.not.objectContaining({ avatar: expect.any(String) })
    )
    await thirdStore.close()
  })

  test('updateWorkerProfile does not mutate memory when DB update fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-profile-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = workspaceStore.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('UPDATE workers SET name = ?, avatar = ?')) {
        throw new Error('update worker failed')
      }
      return originalPrepare(source)
    })

    expect(() =>
      workspaceStore.updateWorkerProfile(workspace.id, worker.id, {
        avatar: tinyAvatar,
        name: 'Bob',
      })
    ).toThrow(/update worker failed/)
    expect(workspaceStore.getWorker(workspace.id, worker.id)).toMatchObject({ name: 'Alice' })
    expect(workspaceStore.getWorker(workspace.id, worker.id).avatar).toBeUndefined()

    db.close()
  })

  test('dispatchTask increments worker pending count and marks it working', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY started: worker is idle, not stopped (spec §3.6.4 keeps
    // stopped workers from being silently promoted to working when their
    // PTY isn't actually running).
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('working')
  })

  test('dispatchTask keeps a stopped worker stopped while accumulating queue', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // worker.addWorker initialises status='stopped' (PTY hasn't started).

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('startAgent success promotes a fresh worker from stopped to idle', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: process.execPath, args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })

  test('startAgent keeps a queued worker working while backlog remains', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Worker was running, took a dispatch (pendingTaskCount=1, status='working'),
    // then user hit [Restart]. Once a PTY is alive again, spec §3.6 derives
    // worker status from the remaining pending_task_count.
    store.getWorker(workspace.id, worker.id).status = 'idle'
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.configureAgentLaunch(workspace.id, worker.id, { command: process.execPath, args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('working')
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('startAgent transitions a stopped worker with pending backlog to working', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate the hydration end-state after a hive restart: worker status is
    // 'stopped' (PTY isn't running), but dispatch ledger replay left
    // pendingTaskCount > 0 because the previous session ended before the
    // worker reported back. User hits [Restart] -> startAgent, so the PTY is
    // alive and pending_task_count makes it working again.
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    store.configureAgentLaunch(workspace.id, worker.id, { command: process.execPath, args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('working')
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('reportTask resets worker pending count and returns it to idle', async () => {
    const { store, workspace, worker, send, report } = await startReportWorker()
    const dispatch = await send('Implement feature')
    expect((await report(dispatch.id, 'Done')).status).toBe(202)

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('idle')
  })

  test('reportTask keeps a stopped worker stopped while draining pending count', async () => {
    const { store, workspace, worker, send, runId } = await startReportWorker()
    const dispatch = await send('Implement feature')
    store.stopAgentRun(runId)
    expect(await store.waitForRunExit(runId, 5000)).toBe(true)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    // Exercise the internal store transition, not a revoked HTTP agent token.
    store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      status: 'success',
      text: 'Done',
    })

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
        description: CODER_ROLE_DESCRIPTION,
        status: 'stopped',
        pendingTaskCount: 0,
      },
      {
        id: expect.any(String),
        name: 'Bob',
        role: 'tester',
        description: TESTER_ROLE_DESCRIPTION,
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

  test('normalizes worker names on create before storing and matching duplicates', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const worker = store.addWorker(workspace.id, {
      name: ' Alice ',
      role: 'coder',
    })

    expect(worker.name).toBe('Alice')
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, name: 'Alice' })
    )
    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('rejects blank worker names on create', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(() => store.addWorker(workspace.id, { name: '   ', role: 'coder' })).toThrow(
      'Worker name must not be empty'
    )
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
