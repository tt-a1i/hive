import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { type AgentManager, createAgentManager } from '../../src/server/agent-manager.js'
import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const sessionStore = {
  clearLastSessionId: () => {},
  getLastSessionId: () => undefined,
  setLastSessionId: () => {},
}

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []

const waitFor = async (assertion: () => void, timeoutMs = 4000, intervalMs = 25) => {
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

const prepareWorkspace = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-lifecycle-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  return { dataDir, workspacePath }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

const createAgentManagerWithDuplicatedOnExit = (): AgentManager => {
  const manager = createAgentManager()

  return {
    getRun: manager.getRun,
    getOutputBus: manager.getOutputBus,
    pauseRun: manager.pauseRun,
    removeRun: manager.removeRun,
    resizeRun: manager.resizeRun,
    resumeRun: manager.resumeRun,
    stopRun: manager.stopRun,
    writeInput: manager.writeInput,
    startAgent(input) {
      if (!input.onExit) {
        return manager.startAgent(input)
      }

      return manager.startAgent({
        ...input,
        onExit: (event) => {
          input.onExit?.(event)
          input.onExit?.(event)
        },
      })
    },
  }
}

const createDelayedStartAgentManager = (manager = createAgentManager()) => {
  let releaseStart: (() => void) | undefined
  let startRequested = false
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })

  const delayedManager: AgentManager = {
    getRun: manager.getRun,
    getOutputBus: manager.getOutputBus,
    pauseRun: manager.pauseRun,
    removeRun: manager.removeRun,
    resizeRun: manager.resizeRun,
    resumeRun: manager.resumeRun,
    stopRun: manager.stopRun,
    writeInput: manager.writeInput,
    async startAgent(input) {
      startRequested = true
      await startGate
      return manager.startAgent(input)
    },
  }

  return {
    manager,
    delayedManager,
    releaseStart: () => releaseStart?.(),
    startRequested: () => startRequested,
  }
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('lifecycle hardening (R2.1 / R2.2 / R2.3) — real PTY', () => {
  test('concurrent starts for the same agent share one live PTY run', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'long-running.js')
    const pidsFile = join(workspacePath, 'concurrent-pids.txt')
    writeFileSync(
      script,
      [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n')`,
        "process.stdin.resume(); setInterval(() => {}, 1000); console.log('started')",
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    let closed = false
    try {
      const runs = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
        )
      )

      expect(new Set(runs.map((run) => run.runId)).size).toBe(1)
      await waitFor(() => {
        expect(store.getLiveRun(runs[0].runId).status).toBe('running')
      })
      let spawnedPid: number | undefined
      await waitFor(() => {
        const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean)
        expect(new Set(pids).size).toBe(1)
        expect(pids).toHaveLength(1)
        spawnedPid = Number(pids[0])
        expect(isProcessAlive(spawnedPid)).toBe(true)
      })
      expect(store.listAgentRuns(worker.id).filter((run) => run.status === 'running')).toHaveLength(
        1
      )
      await store.close()
      closed = true
      await waitFor(() => {
        if (!spawnedPid) throw new Error('Expected spawned pid')
        expect(isProcessAlive(spawnedPid)).toBe(false)
      })
    } finally {
      if (!closed) await store.close()
    }
  })

  test('runtime startup marks persisted unfinished runs as stale errors', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace(workspacePath, 'Alpha')
    const worker = workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const startedAt = Date.now() - 60_000
    db.prepare(
      `INSERT INTO agent_runs (run_id, agent_id, pid, status, exit_code, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('stale-run', worker.id, 999_999, 'running', null, startedAt, null, startedAt, startedAt)
    db.close()

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })

    expect(store.listAgentRuns(worker.id)).toContainEqual(
      expect.objectContaining({
        endedAt: expect.any(Number),
        exitCode: null,
        runId: 'stale-run',
        status: 'error',
      })
    )

    await store.close()
  })

  test('R2.1: a real node subprocess that exits fast persists agent_runs as exited, not running', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    // Real script that exits immediately.
    const script = join(workspacePath, 'quick-exit.js')
    writeFileSync(script, 'process.exit(0)\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    const run = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    await waitFor(() => {
      const snapshot = store.getLiveRun(run.runId)
      expect(snapshot.status).toBe('exited')
    })

    await store.close()

    // Verify DB landed the final state, not 'starting'/'running'.
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const rows = db
      .prepare('SELECT status, ended_at, pid FROM agent_runs WHERE agent_id = ?')
      .all(worker.id) as Array<{ ended_at: number | null; pid: number | null; status: string }>
    db.close()

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.status).toBe('exited')
      expect(row.ended_at).toEqual(expect.any(Number))
      expect(row.pid).toEqual(expect.any(Number))
    }
  })

  test('R2.2: double stop on a running process triggers onExit once and leaves worker stopped', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'long-running.js')
    writeFileSync(
      script,
      "process.stdin.resume(); setInterval(() => {}, 1000); console.log('started')\n"
    )

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const agentRunStore = createAgentRunStore(db)
    const onAgentExitSpy = vi.fn((workspaceId: string, agentId: string) => {
      workspaceStore.markAgentStopped(workspaceId, agentId)
    })
    const runtime = createAgentRuntime(
      createAgentManagerWithDuplicatedOnExit(),
      agentRunStore,
      sessionStore,
      () => undefined,
      onAgentExitSpy
    )
    const workspace = workspaceStore.createWorkspace(workspacePath, 'Alpha')
    const worker = workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    runtime.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })
    workspaceStore.markAgentStarted(workspace.id, worker.id)

    const run = await runtime.startAgent(workspace, worker.id, { hivePort: '4010' })

    await waitFor(() => {
      expect(runtime.getLiveRun(run.runId).status).toBe('running')
    })

    runtime.stopAgentRun(run.runId)
    runtime.stopAgentRun(run.runId)

    await waitFor(() => {
      expect(runtime.getLiveRun(run.runId).status).toBe('exited')
    })

    expect(onAgentExitSpy).toHaveBeenCalledTimes(1)
    expect(
      db
        .prepare('SELECT status, ended_at FROM agent_runs WHERE run_id = ?')
        .all(run.runId) as Array<{ ended_at: number | null; status: string }>
    ).toEqual([{ ended_at: expect.any(Number), status: 'exited' }])

    // Worker should be marked stopped in workspace-level summary.
    expect(workspaceStore.getWorker(workspace.id, worker.id).status).toBe('stopped')

    await runtime.close()
    agentRunStore.close?.()
    db.close()
  })

  test('R2.3: POST /api/team/send to a worker with no launch config returns 409 and records no send message', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    // Orchestrator needs a LIVE pty so the authz token is valid and the run is active.
    const orchScript = join(workspacePath, 'passive.js')
    writeFileSync(orchScript, 'process.stdin.resume();\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [orchScript],
    })
    await store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })

    // Worker exists but has no launch config, so runtime cannot autostart it.
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const token = store.peekAgentToken(orchestrator.id)

    const response = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token,
        to: 'Alice',
        text: 'should not be delivered',
      }),
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/No worker launch config available/)

    const sendMessages = store
      .listMessagesForRecovery(workspace.id, 0)
      .filter((m) => m.type === 'send')
    expect(sendMessages).toEqual([])
    expect(store.listDispatches(workspace.id)).toEqual([])
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(0)

    await store.close()
  })

  test('deleteWorker rolls back dispatch ledger when worker deletion fails in sqlite', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const store = createRuntimeStore({ dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    await store.dispatchTask(workspace.id, worker.id, 'keep this dispatch')

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_worker_delete
      BEFORE DELETE ON workers
      BEGIN
        SELECT RAISE(ABORT, 'blocked worker delete');
      END;
    `)

    try {
      expect(() => store.deleteWorker(workspace.id, worker.id)).toThrow(/blocked worker delete/)
      expect(store.listDispatches(workspace.id)).toContainEqual(
        expect.objectContaining({ text: 'keep this dispatch', toAgentId: worker.id })
      )
      expect(store.getWorker(workspace.id, worker.id)).toEqual(
        expect.objectContaining({ id: worker.id, pendingTaskCount: 1 })
      )
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_worker_delete')
      db.close()
      await store.close()
    }
  })

  test('deleteWorkspace rolls back dispatch ledger when workspace deletion fails in sqlite', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const store = createRuntimeStore({ dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    await store.dispatchTask(workspace.id, worker.id, 'keep workspace dispatch')

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_workspace_delete
      BEFORE DELETE ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'blocked workspace delete');
      END;
    `)

    try {
      await expect(store.deleteWorkspace(workspace.id)).rejects.toThrow(/blocked workspace delete/)
      expect(store.listWorkspaces()).toContainEqual(workspace)
      expect(store.listDispatches(workspace.id)).toContainEqual(
        expect.objectContaining({ text: 'keep workspace dispatch', toAgentId: worker.id })
      )
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_workspace_delete')
      db.close()
      await store.close()
    }
  })

  test('close removes agent-manager run records after PTY shutdown', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'long-running.js')
    writeFileSync(
      script,
      "process.stdin.resume(); setInterval(() => {}, 1000); console.log('started')\n"
    )

    const agentManager = createAgentManager()
    const store = createRuntimeStore({ agentManager, dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    const run = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    await waitFor(() => {
      expect(store.getLiveRun(run.runId).status).toBe('running')
    })

    store.stopAgentRun(run.runId)
    await waitFor(() => {
      expect(store.getLiveRun(run.runId).status).toBe('exited')
    })
    await waitFor(() => {
      expect(store.peekAgentToken(worker.id)).toBeUndefined()
    })

    await store.close()

    expect(() => agentManager.getRun(run.runId)).toThrow(/Run not found/)
  })

  test('close force-kills a PTY that ignores graceful stop signals', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'ignore-stop.js')
    writeFileSync(
      script,
      [
        "process.on('SIGHUP', () => {})",
        "process.on('SIGTERM', () => {})",
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
        "console.log('stubborn-started')",
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    const run = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(store.getLiveRun(run.runId).status).toBe('running')
    })
    const pid = store.getLiveRun(run.runId).pid
    if (pid === null) throw new Error('Expected PTY pid')

    const closeResult = await Promise.race([
      store.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ])

    if (closeResult === 'timeout') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await store.close()
    }

    expect(closeResult).toBe('closed')
  })

  test('close waits for an in-flight agent start before tearing down live runs', async () => {
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'delayed-start.js')
    writeFileSync(script, "console.log('delayed-started'); setInterval(() => {}, 1000)\n")

    const delayed = createDelayedStartAgentManager()
    const store = createRuntimeStore({ agentManager: delayed.delayedManager, dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    const startPromise = store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(delayed.startRequested()).toBe(true)
    })

    let closeResolved = false
    const closePromise = store.close().then(() => {
      closeResolved = true
    })

    await delay(100)
    const resolvedBeforeRelease = closeResolved
    delayed.releaseStart()

    let runId: string | undefined
    try {
      runId = (await startPromise).runId
    } finally {
      await closePromise
    }

    expect(resolvedBeforeRelease).toBe(false)
    if (!runId) throw new Error('Expected delayed start to resolve')
    expect(() => delayed.manager.getRun(runId)).toThrow(/Run not found/)
  })

  test('close force-kills child processes that outlive the PTY leader', async () => {
    if (process.platform === 'win32') return
    const { dataDir, workspacePath } = prepareWorkspace()
    const script = join(workspacePath, 'orphan-child.js')
    const childScript = [
      "process.on('SIGHUP', () => {})",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';')
    writeFileSync(
      script,
      [
        "const { spawn } = require('node:child_process')",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
          stdio: 'ignore',
        })`,
        'child.unref()',
        "console.log('CHILD_PID=' + child.pid)",
        'setTimeout(() => process.exit(0), 300)',
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })

    let childPid: number | undefined
    try {
      const run = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
      await waitFor(() => {
        const output = store.getLiveRun(run.runId).output
        const match = output.match(/CHILD_PID=(\d+)/)
        expect(match?.[1]).toBeTruthy()
        childPid = Number(match?.[1])
      })
      if (!childPid) throw new Error('Expected child pid')
      expect(isProcessAlive(childPid)).toBe(true)
      await waitFor(() => {
        expect(store.getLiveRun(run.runId).status).toBe('exited')
      })
      await waitFor(() => {
        if (!childPid) throw new Error('Expected child pid')
        expect(isProcessAlive(childPid)).toBe(false)
      }, 3000)
      await store.close()
    } finally {
      if (childPid && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL')
    }
  })
})
