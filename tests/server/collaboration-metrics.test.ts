import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import {
  COLLABORATION_DELIVERABLE_CAP,
  queryCollaborationMetrics,
} from '../../src/server/collaboration-metrics.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import type { CollaborationMetrics, CollaborationMetricsAggregate } from '../../src/shared/types.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const waitFor = async (assertion: () => void, timeoutMs = 8000, intervalMs = 25) => {
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

describe('collaboration cost metrics (issue #75)', () => {
  test('records payload bytes and aggregates related dispatches per deliverable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-collab-metrics-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)

      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
      })
      const emptyPath = join(dataDir, 'empty-workspace')
      mkdirSync(emptyPath, { recursive: true })
      const emptyResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Empty', path: emptyPath }),
      })
      const emptyWorkspace = (await emptyResponse.json()) as { id: string }

      const fromAgentId = `${workspace.id}:orchestrator`
      const receivedPath = join(dataDir, 'orchestrator-input.txt')
      const receiverScript = join(workspacePath, 'receiver.cjs')
      writeFileSync(receivedPath, '')
      writeFileSync(
        receiverScript,
        "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',d=>fs.appendFileSync(process.argv[2],d));process.stdout.write('READY')"
      )
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${fromAgentId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [receiverScript, receivedPath] }),
      })
      const started = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${fromAgentId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      expect(started.status).toBe(201)
      await waitFor(() =>
        expect(hive.store.getActiveRunByAgentId(workspace.id, fromAgentId)?.output).toContain(
          'READY'
        )
      )
      const first = await hive.store.dispatchTaskByWorkerName(
        workspace.id,
        'Alice',
        'implement login',
        {
          autoStartWorker: false,
          fromAgentId,
          hivePort: String(hive.port),
        }
      )
      await delay(20)
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.status === 'starting' || run?.status === 'running').toBe(true)
      })
      await waitFor(() => {
        const firstRow = hive.store.listDispatches(workspace.id).find((row) => row.id === first.id)
        expect(firstRow?.dispatchPayloadBytes).toBeGreaterThan(0)
        expect(firstRow?.deliveredAt).not.toBeNull()
      })

      await delay(20)
      const report = async (dispatchId: string, text: string) => {
        const response = await fetch(`${baseUrl}/api/team/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: workspace.id,
            from_agent_id: worker.id,
            token: hive.store.peekAgentToken(worker.id),
            dispatch_id: dispatchId,
            result: text,
            seen_seq: 0,
          }),
        })
        expect(response.status).toBe(202)
      }
      expect(
        hive.store.listDispatches(workspace.id).find((row) => row.id === first.id)
          ?.reportPayloadBytes
      ).toBeNull()
      await report(first.id, 'login done')
      await waitFor(() =>
        expect(
          hive.store.listDispatches(workspace.id).find((row) => row.id === first.id)
            ?.reportPayloadBytes
        ).toBeGreaterThan(0)
      )

      const second = await hive.store.dispatchTaskByWorkerName(
        workspace.id,
        'Alice',
        'review login',
        {
          fromAgentId,
          hivePort: String(hive.port),
          relatedToDispatchId: first.id,
        }
      )
      expect(second.rootDispatchId).toBe(first.id)
      expect(second.parentDispatchId).toBe(first.id)
      await waitFor(() => {
        const secondRow = hive.store
          .listDispatches(workspace.id)
          .find((row) => row.id === second.id)
        expect(secondRow?.dispatchPayloadBytes).toBeGreaterThan(0)
        expect(secondRow?.deliveredAt).not.toBeNull()
      })

      await delay(20)
      expect(
        hive.store.listDispatches(workspace.id).find((row) => row.id === second.id)
          ?.reportPayloadBytes
      ).toBeNull()
      await report(second.id, 'review done')
      await waitFor(() =>
        expect(
          hive.store.listDispatches(workspace.id).find((row) => row.id === second.id)
            ?.reportPayloadBytes
        ).toBeGreaterThan(0)
      )

      const afterReport = hive.store.listDispatches(workspace.id)
      const firstRow = afterReport.find((row) => row.id === first.id)
      const secondRow = afterReport.find((row) => row.id === second.id)
      if (!firstRow || !secondRow) throw new Error('expected both dispatch ledger rows')
      expect(firstRow.reportPayloadBytes).toBeGreaterThan(0)
      expect(secondRow.reportPayloadBytes).toBeGreaterThan(0)
      expect(firstRow.reportedAt).not.toBeNull()
      expect(secondRow.reportedAt).not.toBeNull()
      const dispatchBytesTotal =
        (firstRow.dispatchPayloadBytes ?? 0) + (secondRow.dispatchPayloadBytes ?? 0)
      const reportBytesTotal =
        (firstRow.reportPayloadBytes ?? 0) + (secondRow.reportPayloadBytes ?? 0)
      const firstCreatedAt = Math.min(firstRow.createdAt, secondRow.createdAt)
      const lastReportedAt = Math.max(firstRow.reportedAt ?? 0, secondRow.reportedAt ?? 0)

      const response = await fetch(
        `${baseUrl}/api/diagnostics/collaboration?workspace_id=${workspace.id}`,
        { headers: { cookie: uiCookie } }
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as CollaborationMetrics
      expect(body.workspace_id).toBe(workspace.id)
      expect(body.window_days).toBe(30)
      expect(body.dispatch_count).toBe(2)
      expect(body.reported_count).toBe(2)
      expect(body.cancelled_count).toBe(0)
      expect(body.message_count).toBe(0)
      expect(body.send_to_delivered_ms.p50).toBeGreaterThan(0)
      expect(body.send_to_delivered_ms.p95).toBeGreaterThan(0)
      expect(body.delivered_to_reported_ms.p50).toBeGreaterThan(0)
      expect(body.delivered_to_reported_ms.p95).toBeGreaterThan(0)
      // Dispatches and reports carry short inbox wakeups; measure the exact report
      // wakeups observed by the real orchestrator PTY, independently of the ledger.
      const rawDispatchBytes = Buffer.byteLength('implement login review login', 'utf8')
      expect(dispatchBytesTotal).toBeGreaterThan(rawDispatchBytes)
      expect(dispatchBytesTotal).toBeLessThan(rawDispatchBytes + 2 * 8_000)
      const wakeups =
        readFileSync(receivedPath, 'utf8').match(
          /\[hive-inbox [a-f0-9-]+[^\]\r\n]*\] Read "(?:[^"\\]|\\.)*" for the complete Hive system message\./g
        ) ?? []
      expect(wakeups).toHaveLength(2)
      expect(reportBytesTotal).toBe(
        wakeups.reduce((total, wakeup) => total + Buffer.byteLength(wakeup), 0)
      )
      expect(body.dispatch_payload_bytes.total).toBe(dispatchBytesTotal)
      expect(body.dispatch_payload_bytes.avg).toBe(dispatchBytesTotal / 2)
      expect(body.report_payload_bytes.total).toBe(reportBytesTotal)
      expect(body.report_payload_bytes.avg).toBe(reportBytesTotal / 2)
      expect(body.deliverables).toEqual([
        {
          dispatch_count: 2,
          first_created_at: firstCreatedAt,
          injected_bytes: dispatchBytesTotal + reportBytesTotal,
          last_reported_at: lastReportedAt,
          message_count: 0,
          root_dispatch_id: first.id,
          wall_clock_ms: lastReportedAt - firstCreatedAt,
        },
      ])
      expect(body.deliverables[0]?.wall_clock_ms).toBeGreaterThan(0)

      const empty = await fetch(
        `${baseUrl}/api/diagnostics/collaboration?workspace_id=${emptyWorkspace.id}&days=7`,
        { headers: { cookie: uiCookie } }
      )
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({
        cancelled_count: 0,
        deliverables: [],
        delivered_to_reported_ms: { p50: null, p95: null },
        dispatch_count: 0,
        dispatch_payload_bytes: { avg: null, total: 0 },
        message_count: 0,
        report_payload_bytes: { avg: null, total: 0 },
        reported_count: 0,
        send_to_delivered_ms: { p50: null, p95: null },
        window_days: 7,
        workspace_id: emptyWorkspace.id,
      })

      const bundle = await fetch(`${baseUrl}/api/diagnostics/support-bundle`, {
        headers: { cookie: uiCookie },
      })
      const bundleBody = (await bundle.json()) as {
        workspaces: {
          items: Array<{ collaboration: CollaborationMetricsAggregate; id: string }>
        }
      }
      const collab = bundleBody.workspaces.items.find(
        (item) => item.id === workspace.id
      )?.collaboration
      expect(collab).toMatchObject({
        dispatch_count: 2,
        reported_count: 2,
        workspace_id: workspace.id,
      })
      expect(collab).not.toHaveProperty('deliverables')
    } finally {
      await hive.close()
    }
  }, 30_000)
})

describe('queryCollaborationMetrics', () => {
  const insertDispatch = (
    db: Database,
    row: {
      createdAt: number
      deliveredAt?: number | null
      dispatchBytes?: number | null
      id: string
      reportBytes?: number | null
      reportedAt?: number | null
      rootId?: string
      status?: string
    }
  ) => {
    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, to_agent_id, text, status, created_at,
        delivered_at, reported_at, dispatch_payload_bytes, report_payload_bytes,
        root_dispatch_id, seen_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      row.id,
      'ws-metrics',
      'worker-1',
      'task',
      row.status ?? 'reported',
      row.createdAt,
      row.deliveredAt === undefined ? null : row.deliveredAt,
      row.reportedAt === undefined ? null : row.reportedAt,
      row.dispatchBytes === undefined ? null : row.dispatchBytes,
      row.reportBytes === undefined ? null : row.reportBytes,
      row.rootId ?? row.id
    )
  }

  test('excludes NULL byte columns from averages and skips undelivered durations', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    insertDispatch(db, {
      createdAt: 1_000,
      deliveredAt: 1_050,
      dispatchBytes: 100,
      id: 'measured',
      reportBytes: 40,
      reportedAt: 1_200,
    })
    insertDispatch(db, {
      createdAt: 2_000,
      deliveredAt: null,
      dispatchBytes: null,
      id: 'pre-v44-null',
      reportBytes: null,
      reportedAt: 2_100,
    })
    const metrics = queryCollaborationMetrics(db, 'ws-metrics', 30, 10_000)
    expect(metrics.dispatch_count).toBe(2)
    expect(metrics.dispatch_payload_bytes).toEqual({ avg: 100, total: 100 })
    expect(metrics.report_payload_bytes).toEqual({ avg: 40, total: 40 })
    expect(metrics.send_to_delivered_ms.p50).toBe(50)
    expect(metrics.send_to_delivered_ms.p95).toBe(50)
    expect(metrics.delivered_to_reported_ms.p50).toBe(150)
    expect(metrics.send_to_delivered_ms.p50).toBeGreaterThan(0)
    db.close()
  })

  test('caps deliverables at 200 most recent first', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    for (let index = 0; index < COLLABORATION_DELIVERABLE_CAP + 5; index += 1) {
      insertDispatch(db, {
        createdAt: 1_000 + index,
        id: `root-${index}`,
        status: 'queued',
      })
    }
    const metrics = queryCollaborationMetrics(db, 'ws-metrics', 30, 100_000)
    expect(metrics.dispatch_count).toBe(COLLABORATION_DELIVERABLE_CAP + 5)
    expect(metrics.deliverables).toHaveLength(COLLABORATION_DELIVERABLE_CAP)
    expect(metrics.deliverables[0]?.root_dispatch_id).toBe(
      `root-${COLLABORATION_DELIVERABLE_CAP + 4}`
    )
    expect(metrics.deliverables.at(-1)?.root_dispatch_id).toBe('root-5')
    db.close()
  })
})
