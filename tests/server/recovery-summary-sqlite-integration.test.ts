import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildRecoverySummary } from '../../src/server/recovery-summary.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('recovery summary sqlite integration', () => {
  test('runtime-store messages can be passed directly into buildRecoverySummary', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-recovery-messages-'))
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.recordUserInput(workspace.id, orchestrator.id, '帮我实现登录')
    store.dispatchTask(workspace.id, worker.id, '实现登录接口')
    store.reportTask(workspace.id, worker.id, { status: 'success', text: '已完成登录接口' })

    const summary = buildRecoverySummary({
      workspaceName: workspace.name,
      agentRole: 'orchestrator',
      tasksContent: '- [ ] login\n',
      workers: store.listWorkers(workspace.id),
      messages: store.listMessagesForRecovery(workspace.id, 0),
    })

    expect(summary).toContain('user: 帮我实现登录')
    expect(summary).toContain('send ->')
    expect(summary).toContain('report <-')
  })
})
