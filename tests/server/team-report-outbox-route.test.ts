import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { requireAgentToken } from '../helpers/auth.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const failReportOutboxInserts = (dataDir: string): void => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    db.exec(`
      CREATE TRIGGER fail_report_outbox_insert
      BEFORE INSERT ON report_outbox
      BEGIN
        SELECT RAISE(FAIL, 'outbox database failed');
      END;
    `)
  } finally {
    db.close()
  }
}

const failDispatchReportUpdates = (dataDir: string): void => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    db.exec(`
      CREATE TRIGGER fail_dispatch_report_update
      BEFORE UPDATE OF status ON dispatches
      WHEN NEW.status = 'reported'
      BEGIN
        SELECT RAISE(FAIL, 'dispatch ledger failed');
      END;
    `)
  } finally {
    db.close()
  }
}

const countPendingOutboxRows = (dataDir: string, dispatchId: string): number => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  try {
    return (
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL'
        )
        .get(dispatchId) as { count: number }
    ).count
  } finally {
    db.close()
  }
}

const listPendingOutboxPayloads = (dataDir: string, dispatchId: string): string[] => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  try {
    return (
      db
        .prepare(
          'SELECT payload FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL ORDER BY id ASC'
        )
        .all(dispatchId) as Array<{ payload: string }>
    ).map((row) => row.payload)
  } finally {
    db.close()
  }
}

const insertPendingOutboxRow = (
  dataDir: string,
  input: { dispatchId: string; payload: string; targetAgentId: string; workspaceId: string }
): void => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    db.prepare(
      `INSERT INTO report_outbox
        (workspace_id, target_agent_id, dispatch_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.workspaceId, input.targetAgentId, input.dispatchId, input.payload, Date.now())
  } finally {
    db.close()
  }
}

const setupOfflineReportHarness = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-report-outbox-route-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const workerScript = join(workspacePath, 'passive-worker.js')
  writeFileSync(
    workerScript,
    "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.on('data', data => process.stdout.write(data)); process.stdout.write('OUTBOX_WORKER_READY'); process.stdin.resume()\n"
  )
  writeFileSync(join(workspacePath, 'login-result.txt'), 'Login implementation verified\n')

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  expect(workspaceResponse.status).toBe(201)
  const workspace = (await workspaceResponse.json()) as { id: string }

  const workerResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  expect(workerResponse.status).toBe(201)
  const worker = (await workerResponse.json()) as { id: string }

  const configureResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: process.execPath, args: [workerScript] }),
    }
  )
  expect(configureResponse.status).toBe(204)
  const startResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: new URL(server.baseUrl).port }),
    }
  )
  expect(startResponse.status).toBe(201)
  await expect
    .poll(() => server.store.getActiveRunByAgentId(workspace.id, worker.id)?.output)
    .toContain('OUTBOX_WORKER_READY')
  const workerToken = requireAgentToken(server.store, worker.id)
  expect(server.store.validateAgentToken(worker.id, workerToken)).toBe(true)

  const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Implement login', {
    fromAgentId: `${workspace.id}:orchestrator`,
  })
  await expect
    .poll(() => server.store.getActiveRunByAgentId(workspace.id, worker.id)?.output)
    .toContain('Implement login')
  await expect
    .poll(() => server.store.listDispatches(workspace.id).find((item) => item.id === dispatch.id))
    .toMatchObject({ status: 'submitted', deliveredAt: expect.any(Number) })
  expect(server.store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)

  return { cookie, dataDir, dispatch, server, worker, workerToken, workspace, workspacePath }
}

const reportDone = async (input: Awaited<ReturnType<typeof setupOfflineReportHarness>>) =>
  fetch(`${input.server.baseUrl}/api/team/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: input.workspace.id,
      from_agent_id: input.worker.id,
      token: input.workerToken,
      dispatch_id: input.dispatch.id,
      result: 'Done',
      artifacts: ['login-result.txt'],
    }),
  })

describe('POST /api/team/report redelivery outbox failure', () => {
  test('keeps the dispatch open and records no report when offline redelivery cannot be queued', async () => {
    const harness = await setupOfflineReportHarness()
    failReportOutboxInserts(harness.dataDir)

    const reportResponse = await reportDone(harness)

    expect(reportResponse.status).toBe(500)
    expect(
      harness.server.store
        .listMessagesForRecovery(harness.workspace.id, 0)
        .filter((item) => item.type === 'report')
    ).toEqual([])
    expect(harness.server.store.listDispatches(harness.workspace.id)).toEqual([
      expect.objectContaining({
        id: harness.dispatch.id,
        reportText: null,
        status: 'submitted',
      }),
    ])
    expect(
      harness.server.store.getWorker(harness.workspace.id, harness.worker.id).pendingTaskCount
    ).toBe(1)
  })

  test('rolls back the prequeued report when dispatch ledger update fails', async () => {
    const harness = await setupOfflineReportHarness()
    failDispatchReportUpdates(harness.dataDir)

    const reportResponse = await reportDone(harness)

    expect(reportResponse.status).toBe(500)
    expect(countPendingOutboxRows(harness.dataDir, harness.dispatch.id)).toBe(0)
    expect(
      harness.server.store
        .listMessagesForRecovery(harness.workspace.id, 0)
        .filter((item) => item.type === 'report')
    ).toEqual([])
    expect(harness.server.store.listDispatches(harness.workspace.id)).toEqual([
      expect.objectContaining({
        id: harness.dispatch.id,
        reportText: null,
        status: 'submitted',
      }),
    ])
    expect(
      harness.server.store.getWorker(harness.workspace.id, harness.worker.id).pendingTaskCount
    ).toBe(1)
  })

  test('deleting a worker preserves and redelivers its accepted report evidence', async () => {
    const harness = await setupOfflineReportHarness()

    const reportResponse = await reportDone(harness)

    expect(reportResponse.status).toBe(202)
    expect(countPendingOutboxRows(harness.dataDir, harness.dispatch.id)).toBe(1)

    harness.server.store.deleteWorker(harness.workspace.id, harness.worker.id)

    expect(countPendingOutboxRows(harness.dataDir, harness.dispatch.id)).toBe(1)
    expect(harness.server.store.listDispatches(harness.workspace.id)).toContainEqual(
      expect.objectContaining({ id: harness.dispatch.id, status: 'reported', reportText: 'Done' })
    )
    expect(
      harness.server.store
        .listWorkers(harness.workspace.id)
        .some((worker) => worker.id === harness.worker.id)
    ).toBe(false)
    const historyResponse = await fetch(
      `${harness.server.baseUrl}/api/ui/workspaces/${harness.workspace.id}/dispatches`,
      { headers: { cookie: harness.cookie } }
    )
    expect(historyResponse.status).toBe(200)
    expect(await historyResponse.json()).toContainEqual(
      expect.objectContaining({
        id: harness.dispatch.id,
        state: 'reported',
        report_text: 'Done',
        artifacts: ['login-result.txt'],
      })
    )

    const orchestratorId = `${harness.workspace.id}:orchestrator`
    const script = join(harness.workspacePath, 'orchestrator-echo.cjs')
    writeFileSync(
      script,
      "process.stdin.setRawMode?.(true); process.stdin.on('data', data => process.stdout.write(data)); process.stdin.resume()\n"
    )
    const headers = { 'content-type': 'application/json', cookie: harness.cookie }
    const configured = await fetch(
      `${harness.server.baseUrl}/api/workspaces/${harness.workspace.id}/agents/${orchestratorId}/config`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: process.execPath, args: [script] }),
      }
    )
    expect(configured.status).toBe(204)
    const started = await fetch(
      `${harness.server.baseUrl}/api/workspaces/${harness.workspace.id}/agents/${orchestratorId}/start`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ hive_port: new URL(harness.server.baseUrl).port }),
      }
    )
    expect(started.status).toBe(201)
    const run = (await started.json()) as { run_id: string }
    await expect
      .poll(
        async () => {
          const response = await fetch(`${harness.server.baseUrl}/api/runtime/runs/${run.run_id}`, {
            headers,
          })
          expect(response.status).toBe(200)
          return ((await response.json()) as { output: string }).output
        },
        { timeout: 5000 }
      )
      .toContain('<hive-message kind="report" from="@Alice"')
    const received = await fetch(`${harness.server.baseUrl}/api/runtime/runs/${run.run_id}`, {
      headers,
    })
    const output = ((await received.json()) as { output: string }).output
    expect(output).toContain(`dispatch_id: ${harness.dispatch.id}`)
    expect(output).toContain('Done')
    expect(output).toContain('artifact: login-result.txt')
    await expect
      .poll(() => countPendingOutboxRows(harness.dataDir, harness.dispatch.id), { timeout: 5000 })
      .toBe(0)
  })

  test('deleting a worker replaces stale pending redelivery with a dropped-dispatch notice', async () => {
    const harness = await setupOfflineReportHarness()
    const orchestratorId = `${harness.workspace.id}:orchestrator`
    insertPendingOutboxRow(harness.dataDir, {
      workspaceId: harness.workspace.id,
      targetAgentId: orchestratorId,
      dispatchId: harness.dispatch.id,
      payload: 'stale pending report',
    })

    harness.server.store.deleteWorker(harness.workspace.id, harness.worker.id)

    const payloads = listPendingOutboxPayloads(harness.dataDir, harness.dispatch.id)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toContain('DROPPED')
    expect(payloads[0]).toContain(harness.dispatch.id)
    expect(payloads[0]).not.toContain('stale pending report')
    expect(harness.server.store.listDispatches(harness.workspace.id)).toContainEqual(
      expect.objectContaining({
        id: harness.dispatch.id,
        status: 'cancelled',
        reportText: 'Worker removed',
      })
    )
  })
})
