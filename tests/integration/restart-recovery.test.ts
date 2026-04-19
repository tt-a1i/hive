import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { buildRecoverySummary } from '../../src/server/recovery-summary.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('restart recovery', () => {
  test('messages from restarted runtime can build layer B summary', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-restart-recovery-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const firstStore = createRuntimeStore({ dataDir })
      const workspace = firstStore.createWorkspace(workspacePath, 'Alpha')
      const orchestrator = firstStore.getWorkspaceSnapshot(workspace.id).agents[0]
      if (!orchestrator) {
        throw new Error('Expected default orchestrator')
      }

      const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      firstStore.recordUserInput(workspace.id, orchestrator.id, '帮我实现登录')
      firstStore.dispatchTask(workspace.id, worker.id, '实现登录接口')
      firstStore.dispatchTask(workspace.id, worker.id, '补登录测试')
      firstStore.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: '已完成登录接口',
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }

    const secondStore = createRuntimeStore({ dataDir })
    const workspace = secondStore.listWorkspaces()[0]
    if (!workspace) {
      throw new Error('Expected workspace after restart')
    }

    const summary = buildRecoverySummary({
      workspaceName: workspace.name,
      agentRole: 'orchestrator',
      tasksContent: '- [ ] login\n',
      workers: secondStore.listWorkers(workspace.id),
      messages: secondStore.listMessagesForRecovery(workspace.id, 0),
    })

    expect(summary).toContain('user: 帮我实现登录')
    expect(summary).toContain('send ->')
    expect(summary).toContain('report <-')
    expect(summary).toContain('补登录测试')
  })
})
