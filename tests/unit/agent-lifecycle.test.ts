import '../helpers/mock-node-pty.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('agent lifecycle (unit)', () => {
  test('persists launch config and records agent runs with injected hive env', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-agent-lifecycle-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'print-runtime-env.js')
    writeFileSync(
      scriptPath,
      [
        "console.log('PORT=' + process.env.HIVE_PORT)",
        "console.log('PROJECT=' + process.env.HIVE_PROJECT_ID)",
        "console.log('AGENT=' + process.env.HIVE_AGENT_ID)",
        "console.log('PATH=' + process.env.PATH)",
        'setTimeout(() => process.exit(0), 10)',
      ].join('\n')
    )

    const firstStore = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = firstStore.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = firstStore.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    firstStore.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: [scriptPath],
      command: process.execPath,
    })

    const secondStore = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })

    const run = await secondStore.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
    })

    await waitFor(() => {
      expect(secondStore.getLiveRun(run.runId).status).toBe('exited')
    })

    const liveRun = secondStore.getLiveRun(run.runId)
    const persistedRun = secondStore.listAgentRuns(orchestrator.id)[0]

    expect(liveRun.output).toContain('PORT=4010')
    expect(liveRun.output).toContain(`PROJECT=${workspace.id}`)
    expect(liveRun.output).toContain(`AGENT=${orchestrator.id}`)
    expect(liveRun.output).toContain('PATH=')
    expect(liveRun.output).toContain('/dist/bin')

    expect(persistedRun).toMatchObject({
      agentId: orchestrator.id,
      exitCode: 0,
      pid: expect.any(Number),
      runId: run.runId,
      status: 'exited',
    })
    expect(persistedRun?.endedAt).toEqual(expect.any(Number))
  })

  test('can stop a running agent run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-agent-stop-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'long-running.js')
    writeFileSync(scriptPath, ['setInterval(() => {}, 1000)', "console.log('started')"].join('\n'))

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: [scriptPath],
      command: process.execPath,
    })

    const run = await store.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
    })

    await waitFor(() => {
      expect(store.getLiveRun(run.runId).output).toContain('started')
    })

    store.stopAgentRun(run.runId)

    await waitFor(() => {
      expect(store.getLiveRun(run.runId).status).toBe('exited')
      expect(store.listAgentRuns(orchestrator.id)[0]?.status).toBe('exited')
    })

    expect(store.listAgentRuns(orchestrator.id)[0]?.pid).toEqual(expect.any(Number))
    expect(store.listAgentRuns(orchestrator.id)[0]?.endedAt).toEqual(expect.any(Number))
  })
})
