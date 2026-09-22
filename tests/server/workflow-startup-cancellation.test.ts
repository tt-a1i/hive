import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

test('stopping during startup terminates the actual child without a late dispatch', async () => {
  const originalPath = process.env.PATH
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-workflow-startup-stop-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const pidFile = join(dataDir, 'child.pid')
  const binDir = prependPassiveWorkflowCliPath(dataDir, ['codex'], originalPath)
  // An isolated executable, not an installed Codex CLI or a mocked PTY. It
  // publishes its real process identity but never announces prompt readiness.
  writeFileSync(
    join(binDir, 'codex-workflow-fake.js'),
    [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      'process.stdin.setRawMode?.(true)',
      'process.stdin.resume()',
      "process.stdout.write('STARTING\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n')
  )
  const scriptPath = join(workspacePath, 'startup.ts')
  writeFileSync(
    scriptPath,
    "export const meta = { name: 'startup-stop', description: 'startup cancellation' }\nawait agent('must not dispatch after stop', { cli: 'codex' })"
  )
  const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
  try {
    const workspace = store.createWorkspace(workspacePath, 'Startup stop fixture')
    const workflow = await store.startWorkflow({
      workspaceId: workspace.id,
      scriptPath,
      hivePort: '0',
    })
    await expect.poll(() => existsSync(pidFile), { timeout: 15000 }).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(childPid)).toBe(true)
    expect(childPid).toBeGreaterThan(0)
    const worker = store.listWorkers(workspace.id)[0]
    if (!worker) throw new Error('Workflow child is missing')
    const live = store.getActiveRunByAgentId(workspace.id, worker.id)
    if (!live) throw new Error('Workflow child has no live run')
    expect(live.startupReadyAt).toBeNull()
    const exited = store.waitForRunExit(live.runId, 5000)
    expect(store.stopWorkflowRun(workflow.id)).toBe(true)
    expect(await exited).toBe(true)
    await expect
      .poll(
        () => {
          try {
            process.kill(childPid, 0)
            return 'alive'
          } catch (error) {
            return (error as NodeJS.ErrnoException).code
          }
        },
        { timeout: 5000 }
      )
      .toBe('ESRCH')
    await expect(live.postStartInputReady).rejects.toBeInstanceOf(Error)
    await expect.poll(() => store.listWorkers(workspace.id)).toEqual([])
    expect(store.listWorkflowRunDispatches(workflow.id)).toEqual([])
    expect(store.getWorkflowRun(workflow.id)?.status).toBe('stopped')
  } finally {
    await store.close()
    process.env.PATH = originalPath
    removeTestPath(dataDir)
  }
}, 30000)
