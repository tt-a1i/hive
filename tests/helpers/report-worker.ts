import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished } from 'vitest'
import { requireAgentToken } from './auth.js'
import { removeTestPath } from './fs-cleanup.js'
import { startTestServer } from './test-server.js'

// Isolated real PTY receiver; never launches a user's installed agent CLI.
export const startReportWorker = async (
  profile: { name?: string; role?: 'coder' | 'tester'; description?: string } = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-report-worker-'))
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  const close = async () => {
    await server?.close()
    server = undefined
  }
  onTestFinished(async () => {
    // If shutdown fails, preserve the directory instead of deleting live state.
    await close()
    removeTestPath(root)
  })
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath)
  const script = join(root, 'receiver.cjs')
  writeFileSync(
    script,
    `process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => process.stdout.write(data))
process.stdout.write('REPORT_RECEIVER_READY\\r\\n')
process.stdin.resume()
`
  )
  const dataDir = join(root, 'data')
  server = await startTestServer({ dataDir })
  const { store, baseUrl } = server
  const workspace = store.createWorkspace(workspacePath, 'Report fixture')
  const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder', ...profile })
  store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [script],
  })
  const run = await store.startAgent(workspace.id, worker.id, { hivePort: new URL(baseUrl).port })
  await expect
    .poll(() => store.getActiveRunByAgentId(workspace.id, worker.id)?.output)
    .toContain('REPORT_RECEIVER_READY')
  const token = requireAgentToken(store, worker.id)
  const send = async (text: string) => {
    const dispatch = await store.dispatchTask(workspace.id, worker.id, text, {
      fromAgentId: `${workspace.id}:orchestrator`,
    })
    await expect
      .poll(() => store.getActiveRunByAgentId(workspace.id, worker.id)?.output)
      .toContain(text)
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ id: dispatch.id, status: 'submitted' })
    )
    await expect
      .poll(
        () =>
          store.listDispatches(workspace.id).find((item) => item.id === dispatch.id)?.deliveredAt
      )
      .toEqual(expect.any(Number))
    return dispatch
  }
  const report = (dispatchId: string, text: string, artifacts: string[] = []) =>
    fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token,
        dispatch_id: dispatchId,
        result: text,
        artifacts,
      }),
    })
  return { store, workspace, worker, send, report, runId: run.runId, dataDir, close }
}
