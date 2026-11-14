import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { expect, test, vi } from 'vitest'
import { InboxWriteError } from '../../src/server/agent-inbox.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { expandInboxReferences } from '../helpers/inbox.js'
import { startTestServer } from '../helpers/test-server.js'

const setup = async (relativeDataDir = false) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-inbox-failure-'))
  const project = join(root, 'project')
  const dataDir = join(root, 'data')
  mkdirSync(project)
  const server = await startTestServer({
    dataDir: relativeDataDir ? relative(process.cwd(), dataDir) : dataDir,
  })
  const workspace = server.store.createWorkspace(project, 'Disk failure')
  const orchestrator = `${workspace.id}:orchestrator`
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const script = join(root, 'receive.cjs')
  writeFileSync(
    script,
    "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data));process.stdout.write('DISK_READY')"
  )
  const paths = [join(root, 'orchestrator.txt'), join(root, 'worker.txt')]
  for (const [index, agent] of [orchestrator, worker.id].entries()) {
    writeFileSync(paths[index] as string, '')
    server.store.configureAgentLaunch(workspace.id, agent, {
      command: process.execPath,
      args: [script, paths[index] as string],
    })
    await server.store.startAgent(workspace.id, agent, { hivePort: new URL(server.baseUrl).port })
    await expect
      .poll(() => server.store.getActiveRunByAgentId(workspace.id, agent)?.output)
      .toContain('DISK_READY')
  }
  return { root, project, dataDir, server, workspace, orchestrator, worker, paths }
}

test('a relative data directory produces absolute references valid from a different worker directory', async () => {
  const harness = await setup(true)
  try {
    const { server, workspace, worker, orchestrator, paths, project } = harness
    const task = 'Read this durable message from the worker project directory.\nFull task details.'
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, task, {
      fromAgentId: orchestrator,
    })
    await expect.poll(() => readFileSync(paths[1] as string, 'utf8')).toContain('[hive-inbox')
    const raw = readFileSync(paths[1] as string, 'utf8')
    const path = JSON.parse(
      raw.match(/\] Read ("(?:[^"\\]|\\.)*") for the complete/)?.[1] as string
    ) as string
    expect(isAbsolute(path)).toBe(true)
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", path],
      { cwd: project, encoding: 'utf8' }
    )
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain(task)
    expect(child.stdout).toContain(`dispatch_id: ${dispatch.id}`)
  } finally {
    await harness.server.close()
    removeTestPath(harness.root)
  }
})

test('real inbox disk failure retains an immediate dispatch and accepted report for delivery after repair', async () => {
  const harness = await setup()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const db = new Database(join(harness.dataDir, 'runtime.sqlite'))
  try {
    const { server, workspace, worker, orchestrator, dataDir, paths } = harness
    const run = server.store.getActiveRunByAgentId(workspace.id, worker.id)
    expect(run).toBeDefined()
    // An already-ready real PTY needs no startup barrier; exercise the synchronous send path.
    if (run) delete run.postStartInputReady
    writeFileSync(join(dataDir, 'inbox'), 'A file blocks the required directory')
    const task = 'Task survives a real disk failure.\nDo not discard this responsibility.'
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, task, {
      fromAgentId: orchestrator,
    })
    expect(
      server.store.listDispatches(workspace.id).find((item) => item.id === dispatch.id)
    ).toMatchObject({ status: 'queued', deliveredAt: null, dispatchPayloadBytes: null })
    expect(server.store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)
    expect(server.store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
      expect.objectContaining({ type: 'send', text: task })
    )
    expect(readFileSync(paths[1] as string, 'utf8')).toBe('')
    rmSync(join(dataDir, 'inbox'))
    if (run) {
      server.store.stopAgentRun(run.runId)
      await server.store.waitForRunExit(run.runId, 5000)
    }
    await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    await expect
      .poll(
        () =>
          server.store.listDispatches(workspace.id).find((item) => item.id === dispatch.id)
            ?.deliveredAt
      )
      .toEqual(expect.any(Number))
    await expect
      .poll(() => expandInboxReferences(readFileSync(paths[1] as string, 'utf8')))
      .toContain(task)
    rmSync(join(dataDir, 'inbox'), { recursive: true })
    writeFileSync(join(dataDir, 'inbox'), 'Blocked again for report delivery')
    const beforeFailure = consoleError.mock.calls.length
    const response = await fetch(`${server.baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: server.store.peekAgentToken(worker.id),
        dispatch_id: dispatch.id,
        result: 'REPORT_EVIDENCE_SURVIVES_DISK_FAILURE',
        seen_seq: 0,
      }),
    })
    expect(response.status).toBe(202)
    await expect
      .poll(() =>
        consoleError.mock.calls
          .slice(beforeFailure)
          .flat()
          .some((value) => value instanceof InboxWriteError)
      )
      .toBe(true)
    const pending = () =>
      db.prepare('SELECT delivered_at FROM report_outbox WHERE dispatch_id = ?').get(dispatch.id)
    expect(pending()).toEqual({ delivered_at: null })
    expect(
      server.store.listDispatches(workspace.id).find((item) => item.id === dispatch.id)
    ).toMatchObject({
      status: 'reported',
      reportText: 'REPORT_EVIDENCE_SURVIVES_DISK_FAILURE',
      reportPayloadBytes: null,
    })
    expect(server.store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(0)
    expect(readFileSync(paths[0] as string, 'utf8')).toBe('')
    rmSync(join(dataDir, 'inbox'))
    server.store.drainReportOutbox(workspace.id)
    await expect.poll(pending).toEqual({ delivered_at: expect.any(Number) })
    await expect
      .poll(() => expandInboxReferences(readFileSync(paths[0] as string, 'utf8')))
      .toContain('REPORT_EVIDENCE_SURVIVES_DISK_FAILURE')
  } finally {
    consoleError.mockRestore()
    db.close()
    await harness.server.close()
    removeTestPath(harness.root)
  }
}, 15000)
