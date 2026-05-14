import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

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

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team prompt contract', () => {
  test('team send injects sender display name, role description, and task text', async () => {
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
    stores.push(store)
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
    const dispatch = await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      const output = run?.output.replace(/\r\n/g, '\n')
      expect(output).toContain('@Orchestrator')
      expect(output).toContain(`你的角色：${worker.description}`)
      expect(output).toContain(`执行 \`team report "<完整汇报>" --dispatch ${dispatch.id}\``)
      expect(output).toContain(`dispatch_id: ${dispatch.id}`)
      expect(output).not.toContain('--success')
      expect(output).not.toContain('--failed')
      expect(output?.trimEnd()).toMatch(/实现登录$/)
    })
  })

  test('team send submits prompts to interactive CLI agents after bracketed paste', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-interactive-team-send-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    const fakeClaude = join(binDir, 'claude')
    writeFileSync(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        'const SUBMIT_READY_DELAY_MS = 150',
        "const PASTE_END = '\\u001b[201~'",
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  if (chunk.includes(PASTE_END)) {',
        '    process.stdout.write("\\n[Pasted text #1 +1 lines]\\n")',
        '    submitReadyAt = Date.now() + SUBMIT_READY_DELAY_MS',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        '  if (isSubmit) {',
        "    if (Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "    else process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '  }',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )
    chmodSync(fakeClaude, 0o755)
    process.env.PATH = `${binDir}:${originalPath ?? ''}`

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { command: 'claude', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('[Hive 系统消息：启动说明]')
      expect(run?.output).toContain('SUBMITTED')
    }, 4000)

    await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('\u001b[200~[Hive 系统消息：来自 @Orchestrator 的派单]')
      expect(run?.output).toContain('实现登录')
      expect(run?.output).toContain('\u001b[201~')
      expect(run?.output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    })
  })
})
