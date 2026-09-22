/** Migration and external-controller checks in temporary stores; no real host notifications. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { runHiveCommand } from '../src/cli/hive.js'
import { callHiveMcpTool } from '../src/cli/hive-mcp.js'
import { createDispatchLedgerStore } from '../src/server/dispatch-ledger-store.js'
import { insertDispatchMessage } from '../src/server/dispatch-message-store.js'
import { createMailboxStore } from '../src/server/mailbox-store.js'
import { openRuntimeDatabase } from '../src/server/runtime-database.js'

const root = await mkdtemp(join(tmpdir(), 'hive-lean-persistence-'))
const previousPath = process.env.PATH
const previousDataDir = process.env.HIVE_DATA_DIR
let runtime: Awaited<ReturnType<typeof runHiveCommand>> | undefined
try {
  const migrationDir = join(root, 'migration')
  let db = openRuntimeDatabase(migrationDir)
  // Reconstruct the exact pre-46 storage surface, preserving a legacy report.
  db.exec(`DROP TABLE mailbox_receipts; DROP TABLE mailbox_batches;
    DROP INDEX idx_dispatches_delegated_from;
    ALTER TABLE dispatches DROP COLUMN delegated_from_id;
    ALTER TABLE dispatches DROP COLUMN outcome;
    DELETE FROM schema_version WHERE version = 46;
    INSERT INTO workspaces(id,name,path,created_at) VALUES ('legacy','Legacy','/tmp',1);
    INSERT INTO workers(id,workspace_id,name,role,created_at) VALUES ('legacy-worker','legacy','Legacy worker','coder',1);
    INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at,root_dispatch_id,seen_seq,report_text)
      VALUES ('legacy-report','legacy','legacy-worker','Old task','reported',1,'legacy-report',0,'Old report');`)
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number })
      .version,
    45
  )
  db.close()
  db = openRuntimeDatabase(migrationDir)
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number })
      .version,
    46
  )
  const legacy = createDispatchLedgerStore(db).getDispatch('legacy', 'legacy-report')
  assert.equal(legacy?.reportText, 'Old report')
  assert.equal(legacy?.outcome, null)
  const active = createDispatchLedgerStore(db).createDispatch({
    workspaceId: 'legacy',
    toAgentId: 'legacy-worker',
    fromAgentId: 'legacy:orchestrator',
    text: 'New task',
  })
  createDispatchLedgerStore(db).claimQueuedDispatch(active.id)
  const message = insertDispatchMessage(db, {
    workspaceId: 'legacy',
    dispatchId: active.id,
    sourceDispatchId: null,
    fromAgentId: 'legacy:orchestrator',
    recipientAgentId: 'legacy-worker',
    kind: 'note',
    replyTo: null,
    text: 'Persisted input',
  })
  const batch = createMailboxStore(db).readMailbox('legacy', 'legacy-worker')
  assert.ok(batch.batchId)
  db.close()
  db = openRuntimeDatabase(migrationDir)
  assert.equal(createMailboxStore(db).readMailbox('legacy', 'legacy-worker').batchId, batch.batchId)
  assert.deepEqual(
    createMailboxStore(db)
      .readMailbox('legacy', 'legacy-worker')
      .messages.map((m) => m.id),
    [message.id]
  )
  const reported = createDispatchLedgerStore(db).markReportedByWorker({
    workspaceId: 'legacy',
    toAgentId: 'legacy-worker',
    dispatchId: active.id,
    ackBatchId: batch.batchId,
    outcome: 'failed',
    reportText: 'Explicit failure',
    artifacts: [],
  })
  assert.equal(reported?.outcome, 'failed')
  db.close()
  db = openRuntimeDatabase(migrationDir)
  assert.equal(createDispatchLedgerStore(db).getDispatch('legacy', active.id)?.outcome, 'failed')
  db.close()

  if (process.argv.includes('--storage-only')) {
    console.log(
      'PASS: v45 migration preserves legacy unknown outcome; batch/outcome survive reopen'
    )
  } else {
    // The production notifier launches codex directly with execFile. Its POSIX
    // test fixture cannot stand in for a native Windows executable.
    if (process.platform === 'win32')
      throw new Error(
        'Use --storage-only on Windows; the external-controller scenario requires a POSIX launcher'
      )
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'codex'),
      '#!/bin/sh\nif [ "$2" = "--help" ]; then exit 0; fi\nexit 1\n',
      { mode: 0o755 }
    )
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
    process.env.HIVE_DATA_DIR = join(root, 'runtime')
    runtime = await runHiveCommand(['--port', '0', '--no-open'])
    const baseUrl = `http://127.0.0.1:${runtime.port}`
    let cookie = ''
    const request = async (path: string, body?: object, expected = body ? 202 : 200) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { cookie, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      })
      assert.equal(response.status, expected, await response.clone().text())
      return response
    }
    cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
    const workspaceId = (
      await (
        await request(
          '/api/workspaces',
          { name: 'External lean check', path: root, controller_mode: 'codex_app' },
          201
        )
      ).json()
    ).id
    let threadId = randomUUID()
    const controller = (action: string, extra: object = {}) =>
      callHiveMcpTool(
        'hive.controller_action',
        { workspace_id: workspaceId, action, ...extra },
        { baseUrl, metadata: { threadId } }
      )
    const statusPath = `/api/workspaces/${workspaceId}/controller`
    const bind = async () => {
      await callHiveMcpTool(
        'hive.controller_connect',
        { workspace_id: workspaceId },
        { baseUrl, metadata: { threadId } }
      )
      const status = await (await request(statusPath)).json()
      await request(`${statusPath}/confirm`, { request_id: status.pending_request.id }, 200)
    }
    await bind()
    const worker = (
      await (
        await request(
          `/api/workspaces/${workspaceId}/workers`,
          { name: 'Probe', role: 'coder' },
          201
        )
      ).json()
    ).id
    const fixture = join(root, 'passive.cjs')
    await writeFile(
      fixture,
      "process.stdin.setRawMode(true); process.stdout.write('PASSIVE_READY\\n'); process.stdin.on('data', data => process.stdout.write(data))\n"
    )
    await request(
      `/api/workspaces/${workspaceId}/agents/${worker}/config`,
      { command: process.execPath, args: [fixture] },
      204
    )
    const run = (await controller('start', { worker_name: 'Probe', operation_id: 'start' })) as {
      run_id: string
    }
    const readinessDeadline = Date.now() + 5000
    while (
      Date.now() < readinessDeadline &&
      !String((await (await request(`/api/runtime/runs/${run.run_id}`)).json()).output).includes(
        'PASSIVE_READY'
      )
    )
      await setTimeout(20)
    const task = (await controller('send', {
      worker_name: 'Probe',
      text: 'External task',
      operation_id: 'send',
    })) as { dispatch_id: string }
    const team = (action: string, body: object, expected = 202) =>
      request(
        `/api/team/${action}`,
        {
          project_id: workspaceId,
          from_agent_id: worker,
          token: runtime?.store.peekAgentToken(worker),
          ...body,
        },
        expected
      )
    const question = (
      await (
        await team('message', {
          dispatch_id: task.dispatch_id,
          recipient: 'orchestrator',
          kind: 'question',
          text: 'Need a decision',
        })
      ).json()
    ).message
    const replyInput = { question_id: question.id, text: 'Use v2', operation_id: 'reply' }
    const reply = (await controller('reply', replyInput)) as {
      message: { id: string; sequence: number }
    }
    assert.deepEqual(await controller('reply', replyInput), reply)
    const questionResult = (await controller('question', { question_id: question.id })) as {
      status: string
      answers: { id: string }[]
    }
    assert.equal(questionResult.status, 'answered')
    assert.deepEqual(
      questionResult.answers.map((a) => a.id),
      [reply.message.id]
    )
    await team('report', {
      dispatch_id: task.dispatch_id,
      seen_seq: reply.message.sequence,
      result: 'Explicit failed result',
      status: 'failed',
    })
    const receipts = (await controller('read_reports')) as {
      reports: { id: number; kind: string; outcome: string | null }[]
    }
    assert.ok(receipts.reports.some((r) => r.outcome === 'failed'))
    await controller('ack_reports', { report_ids: receipts.reports.map((r) => r.id) })
    await controller('stop', { worker_name: 'Probe', operation_id: 'stop' })
    const historical = (await controller('message', {
      dispatch_id: task.dispatch_id,
      kind: 'question',
      text: 'Retire this old question',
      operation_id: 'historical',
    })) as { message: { id: string } }
    assert.equal(
      ((await controller('question', { question_id: historical.message.id })) as { status: string })
        .status,
      'pending'
    )
    const disconnectDeadline = Date.now() + 5000
    while (
      Date.now() < disconnectDeadline &&
      !(await (await request(statusPath)).json()).can_disconnect
    )
      await setTimeout(20)
    await request(`${statusPath}/disconnect`, {}, 200)
    threadId = randomUUID()
    await bind()
    await controller('start', { worker_name: 'Probe', operation_id: 'restart-after-rebind' })
    assert.equal(
      (await (await team('question', { question_id: historical.message.id }, 200)).json()).status,
      'closed'
    )
    await team('reply', { question_id: historical.message.id, text: 'Cannot cross bindings' }, 409)
    assert.equal(
      ((await controller('read_reports')) as { pending_reports: number }).pending_reports,
      0
    )
    console.log(
      'PASS: v45 migration preserves legacy unknown outcome; batch/outcome survive reopen; MCP reply replay; external outcome receipt; rebind closes retired question'
    )
  }
} finally {
  await runtime?.close()
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
  else process.env.HIVE_DATA_DIR = previousDataDir
  await rm(root, { recursive: true, force: true })
}
