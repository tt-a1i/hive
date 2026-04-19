import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 25) => {
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

describe('team prompt contract', () => {
  test('team send injects sender display name and role description, not uuid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-prompt-contract-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => process.stdout.write(chunk))",
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: ['-lc', `"${process.execPath}" "${workerScript}"`],
    })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('@Orchestrator')
      expect(run?.output).toContain('你的角色：')
      expect(run?.output).not.toContain(orchestrator.id)
      expect(run?.output).not.toContain(worker.id)
    })
  })
})
