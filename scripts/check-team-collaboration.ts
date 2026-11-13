/** Real HTTP + SQLite + PTY + CLI contract check; never starts a paid model.
 * Run: pnpm exec tsx scripts/check-team-collaboration.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runHiveCommand } from '../src/cli/hive.js'
import { PtyInactiveError } from '../src/server/http-errors.js'
import BetterSqlite3 from '../src/server/sqlite.js'
import { CURRENT_SCHEMA_VERSION } from '../src/server/sqlite-schema.js'

type Runtime = Awaited<ReturnType<typeof runHiveCommand>>
type Row = { id: string; state: string; text: string; report_text: string | null }
type Inbox = {
  required_seen_seq: number
  messages: Array<{ id: string; sequence: number; text: string; delivery_state: string }>
  related_dispatches: Array<{
    id: string
    root_dispatch_id: string
    parent_dispatch_id: string | null
  }>
}
const startedAt = Date.now()
const receiptPath =
  process.argv[2] === '--receipt' && process.argv[3]
    ? process.argv[3]
    : join(tmpdir(), `hive-collaboration-receipt-${startedAt}.json`)
await mkdir(dirname(receiptPath), { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'hive-collaboration-check-'))
const oldDataDir = process.env.HIVE_DATA_DIR
const oldPath = process.env.PATH
process.env.HIVE_DATA_DIR = root
let runtime: Runtime | undefined
let cookie = ''
let workspaceId = ''
let orchestrator = ''
const runs = new Map<string, string>()
const passed: string[] = []
const pass = (name: string) => {
  passed.push(name)
  console.log(`PASS ${name}`)
}
const base = () => `http://127.0.0.1:${runtime?.port}`
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T
const request = async (path: string, body?: object) =>
  fetch(`${base()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
const expectStatus = async (response: Response, expected: number) => {
  assert.equal(response.status, expected, `${response.url}: ${await response.clone().text()}`)
  return response
}
const team = async (actor: string, command: string, body: object, expected = 202) =>
  expectStatus(
    await request(`/api/team/${command}`, {
      project_id: workspaceId,
      from_agent_id: actor,
      token: runtime?.store.peekAgentToken(actor),
      ...body,
    }),
    expected
  )
const rows = async () =>
  json<Row[]>(
    await expectStatus(await request(`/api/ui/workspaces/${workspaceId}/dispatches`), 200)
  )
const state = async (id: string, expected: string) =>
  assert.equal((await rows()).find((row) => row.id === id)?.state, expected)
const send = async (name: string, text: string, parent?: string) =>
  (
    await json<{ dispatch_id: string }>(
      await team(orchestrator, 'send', {
        to: name,
        text,
        ...(parent ? { related_to_dispatch_id: parent } : {}),
      })
    )
  ).dispatch_id
const inbox = async (actor: string, id: string) =>
  json<Inbox>(await team(actor, 'messages', { dispatch_id: id }, 200))
const message = async (actor: string, id: string, kind: string, text: string, extra: object = {}) =>
  team(actor, 'message', { dispatch_id: id, kind, text, ...extra })
const report = async (actor: string, id: string, seen?: number, expected = 202) =>
  team(
    actor,
    'report',
    {
      dispatch_id: id,
      result: `completed ${id}`,
      ...(seen === undefined ? {} : { seen_seq: seen }),
    },
    expected
  )
const eventually = async (check: () => Promise<void>) => {
  const until = Date.now() + 15000
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= until) throw error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
}
const outputHas = async (actor: string, text: string) =>
  eventually(async () => {
    const output = await json<{ output: string }>(
      await expectStatus(await request(`/api/runtime/runs/${runs.get(actor)}`), 200)
    )
    assert.ok(output.output.includes(text), `PTY ${actor} did not receive ${text}`)
  })
// Read persisted identity without calling messages(), which would itself request a drain.
// Match the delivery-only envelope: recovery summaries can repeat message body text.
const outputMessageEnvelope = async (actor: string, dispatchId: string, messageText: string) => {
  const matches =
    runtime?.store
      .listWorkspaceDispatchMessages(workspaceId)
      .filter((event) => event.dispatchId === dispatchId && event.text === messageText) ?? []
  assert.equal(matches.length, 1, `Expected one persisted message: ${messageText}`)
  const event = matches[0]
  assert.ok(event)
  await outputHas(
    actor,
    `<hive-message kind="${event.kind}" message="${event.id}" dispatch="${event.dispatchId}">`
  )
}
const start = async (actor: string) => {
  const response = await expectStatus(
    await request(`/api/workspaces/${workspaceId}/agents/${actor}/start`, {
      hive_port: String(runtime?.port),
    }),
    201
  )
  runs.set(actor, (await json<{ run_id: string }>(response)).run_id)
}
const cli = async (actor: string, args: string[], expected = 0) => {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
        env: {
          ...process.env,
          HIVE_PORT: String(runtime?.port),
          HIVE_PROJECT_ID: workspaceId,
          HIVE_AGENT_ID: actor,
          HIVE_AGENT_TOKEN: runtime?.store.peekAgentToken(actor),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('team CLI timed out'))
      }, 15000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    }
  )
  assert.equal(result.code, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result
}
try {
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const fixture = join(root, 'passive-agent.cjs')
  await writeFile(
    fixture,
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => process.stdout.write('RECEIVED:' + data));\n"
  )
  runtime = await runHiveCommand(['--port', '0'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  assert.ok(cookie)
  workspaceId = (
    await json<{ id: string }>(
      await expectStatus(
        await request('/api/workspaces', {
          name: 'Collaboration check',
          path: workspacePath,
          autostart_orchestrator: false,
        }),
        201
      )
    )
  ).id
  orchestrator = `${workspaceId}:orchestrator`
  const members: string[] = []
  for (const name of ['Alice', 'Bob', 'Eve']) {
    const member = await json<{ id: string }>(
      await expectStatus(
        await request(`/api/workspaces/${workspaceId}/workers`, {
          name,
          role: 'coder',
          description: `Preserve custom ${name}`,
        }),
        201
      )
    )
    members.push(member.id)
  }
  const [alice, bob, eve] = members as [string, string, string]
  for (const actor of [orchestrator, ...members]) {
    await expectStatus(
      await request(`/api/workspaces/${workspaceId}/agents/${actor}/config`, {
        command: process.execPath,
        args: [fixture, '--model', 'user-selected-selfcheck'],
      }),
      204
    )
    await start(actor)
  }
  const simple = await send('Alice', 'simple independent task')
  await outputHas(alice, simple)
  await cli(alice, ['report', 'simple complete', '--dispatch', simple])
  await state(simple, 'reported')
  pass('legacy CLI report without new requirements; real PTY receives dispatch')
  await outputHas(orchestrator, 'simple complete')
  await runtime.close()
  runtime = undefined
  const legacyDb = new BetterSqlite3(join(root, 'runtime.sqlite'))
  try {
    assert.equal(
      (
        legacyDb.prepare('SELECT COUNT(*) AS count FROM dispatch_messages').get() as {
          count: number
        }
      ).count,
      0
    )
    legacyDb.exec(`DROP TABLE dispatch_message_outbox; DROP TABLE dispatch_messages;
      DROP INDEX idx_dispatches_root; DROP INDEX idx_dispatches_report_notifications;
      ALTER TABLE dispatches DROP COLUMN parent_dispatch_id;
      ALTER TABLE dispatches DROP COLUMN root_dispatch_id;
      ALTER TABLE dispatches DROP COLUMN seen_seq;
      DELETE FROM schema_version WHERE version >= 42;`)
    assert.equal(
      (
        legacyDb.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
          version: number
        }
      ).version,
      41
    )
    assert.deepEqual(
      {
        ...(legacyDb
          .prepare('SELECT id,status,text,report_text FROM dispatches WHERE id=?')
          .get(simple) as object),
      },
      {
        id: simple,
        status: 'reported',
        text: 'simple independent task',
        report_text: 'simple complete',
      }
    )
  } finally {
    legacyDb.close()
  }
  runtime = await runHiveCommand(['--port', '0'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, ...members]) await start(actor)
  const upgradedDb = new BetterSqlite3(join(root, 'runtime.sqlite'), { readOnly: true })
  try {
    assert.deepEqual(
      {
        ...(upgradedDb
          .prepare(
            'SELECT id,status,text,report_text,parent_dispatch_id,root_dispatch_id,seen_seq FROM dispatches WHERE id=?'
          )
          .get(simple) as object),
      },
      {
        id: simple,
        status: 'reported',
        text: 'simple independent task',
        report_text: 'simple complete',
        parent_dispatch_id: null,
        root_dispatch_id: simple,
        seen_seq: 0,
      }
    )
    assert.equal(
      (
        upgradedDb.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
          version: number
        }
      ).version,
      CURRENT_SCHEMA_VERSION
    )
  } finally {
    upgradedDb.close()
  }
  await outputHas(alice, 'Preserve custom Alice')
  pass(
    `schema41-shaped populated database upgrades to ${CURRENT_SCHEMA_VERSION} preserving legacy responsibility and custom role`
  )

  const task = await send('Alice', 'continuous task')
  const initial = await inbox(alice, task)
  assert.equal(initial.required_seen_seq, 0)
  const faultDb = new BetterSqlite3(join(root, 'runtime.sqlite'))
  try {
    const before = faultDb.prepare('SELECT COUNT(*) AS count FROM dispatch_messages').get()
    const beforeOutbox = faultDb
      .prepare('SELECT COUNT(*) AS count FROM dispatch_message_outbox')
      .get()
    faultDb.exec(
      "CREATE TRIGGER selfcheck_outbox_failure BEFORE INSERT ON dispatch_message_outbox BEGIN SELECT RAISE(ABORT, 'selfcheck real database failure'); END"
    )
    await team(
      orchestrator,
      'message',
      { dispatch_id: task, kind: 'note', text: 'must roll back completely' },
      500
    )
    assert.deepEqual(
      faultDb.prepare('SELECT COUNT(*) AS count FROM dispatch_messages').get(),
      before
    )
    assert.deepEqual(
      faultDb.prepare('SELECT COUNT(*) AS count FROM dispatch_message_outbox').get(),
      beforeOutbox
    )
    assert.equal((await inbox(alice, task)).required_seen_seq, 0)
  } finally {
    faultDb.exec('DROP TRIGGER IF EXISTS selfcheck_outbox_failure')
    faultDb.close()
  }
  pass('real SQLite outbox insert failure rolls back message and sequence atomically')

  await cli(alice, [
    'message',
    '--dispatch',
    task,
    '--to',
    'orchestrator',
    '--kind',
    'question',
    'Which requirement?',
  ])
  const question = (await inbox(orchestrator, task)).messages.find(
    (event) => event.text === 'Which requirement?'
  )
  assert.ok(question)
  await state(task, 'submitted')
  await message(orchestrator, task, 'answer', 'Use requirement B', { reply_to: question.id })
  await outputMessageEnvelope(alice, task, 'Use requirement B')
  const answered = await inbox(alice, task)
  assert.ok(answered.required_seen_seq > 0)
  await report(alice, task, undefined, 409)
  await cli(alice, ['report', 'must not auto acknowledge', '--dispatch', task], 1)
  await state(task, 'submitted')
  await state(task, 'submitted')
  const beforeProgress = answered.required_seen_seq
  await message(alice, task, 'progress', 'Working on B', { recipient: 'orchestrator' })
  assert.equal((await inbox(alice, task)).required_seen_seq, beforeProgress)
  assert.equal((await rows()).filter((row) => row.id === task).length, 1)
  assert.equal(
    runtime.store.listWorkers(workspaceId).find((worker) => worker.id === alice)?.pendingTaskCount,
    1
  )
  assert.equal(
    (await inbox(orchestrator, task)).messages.find((event) => event.text === 'Working on B')
      ?.delivery_state,
    'recorded'
  )
  pass(
    'question/answer retains responsibility; legacy report cannot hide new requirements; progress does not require ACK'
  )

  await message(orchestrator, task, 'note', 'Also preserve C')
  await report(alice, task, beforeProgress, 409)
  await report(alice, task, Number.MAX_SAFE_INTEGER, 409)
  await state(task, 'submitted')
  const latest = (await inbox(alice, task)).required_seen_seq
  await cli(alice, ['report', 'B and C completed', '--dispatch', task, '--seen', String(latest)])
  await state(task, 'reported')
  await team(orchestrator, 'message', { dispatch_id: task, kind: 'note', text: 'too late' }, 409)
  pass('ordered append/report races reject stale completion and post-close messages')

  const raced = await send('Alice', 'concurrent completion')
  const identity = {
    project_id: workspaceId,
    token: runtime.store.peekAgentToken(orchestrator),
    from_agent_id: orchestrator,
  }
  const [appendResponse, completionResponse] = await Promise.all([
    request('/api/team/message', {
      ...identity,
      dispatch_id: raced,
      kind: 'note',
      text: 'racing requirement',
    }),
    request('/api/team/report', {
      ...identity,
      token: runtime.store.peekAgentToken(alice),
      from_agent_id: alice,
      dispatch_id: raced,
      result: 'racing completion',
      seen_seq: 0,
    }),
  ])
  assert.deepEqual([appendResponse.status, completionResponse.status].sort(), [202, 409])
  if (appendResponse.status === 202) {
    await state(raced, 'submitted')
    await report(alice, raced, (await inbox(alice, raced)).required_seen_seq)
  }
  await state(raced, 'reported')
  pass('simultaneous append and completion have exactly one winner')

  await message(orchestrator, task, 'question', 'Explain completed outcome')
  const orchQuestion = (await inbox(alice, task)).messages.find(
    (event) => event.text === 'Explain completed outcome'
  )
  assert.ok(orchQuestion)
  await outputMessageEnvelope(alice, task, 'Explain completed outcome')
  await eventually(async () =>
    assert.equal(
      (await inbox(alice, task)).messages.find((event) => event.id === orchQuestion.id)
        ?.delivery_state,
      'delivered'
    )
  )
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await start(alice)
  await outputHas(alice, orchQuestion.id)
  await outputHas(alice, `team reply ${orchQuestion.id} --stdin`)
  await message(alice, task, 'answer', 'Historical explanation only', {
    recipient: 'orchestrator',
    reply_to: orchQuestion.id,
  })
  await outputMessageEnvelope(orchestrator, task, 'Historical explanation only')
  await state(task, 'reported')
  pass('orchestrator can ask a reported owner; exact answer returns without reopening')

  const review = await send('Bob', 'review completed work', task)
  await message(bob, task, 'question', 'Why was C preserved?', { source_dispatch_id: review })
  const historyQuestion = (await inbox(alice, task)).messages.find(
    (event) => event.text === 'Why was C preserved?'
  )
  assert.ok(historyQuestion)
  await outputMessageEnvelope(alice, task, 'Why was C preserved?')
  await eventually(async () =>
    assert.equal(
      (await inbox(alice, task)).messages.find((event) => event.id === historyQuestion.id)
        ?.delivery_state,
      'delivered'
    )
  )
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await start(alice)
  await outputHas(alice, historyQuestion.id)
  await outputHas(alice, review)
  await outputHas(alice, task)
  await outputHas(alice, 'Preserve custom Alice')
  pass('reported owner restart recovers delivered unanswered historical question and custom role')
  await message(alice, review, 'answer', 'C is a compatibility requirement', {
    source_dispatch_id: task,
    reply_to: historyQuestion.id,
  })
  await outputMessageEnvelope(bob, review, 'C is a compatibility requirement')
  await state(task, 'reported')
  await team(
    alice,
    'message',
    {
      dispatch_id: review,
      source_dispatch_id: task,
      kind: 'note',
      text: 'unsolicited closed-source note',
    },
    409
  )
  await team(
    alice,
    'message',
    {
      dispatch_id: review,
      source_dispatch_id: task,
      kind: 'answer',
      reply_to: question.id,
      text: 'wrong answer association',
    },
    403
  )
  pass(
    'reported owner answers exact historical question without reopening; unsolicited closed-source messages rejected'
  )
  const collaborationHistoryUrl = `/api/ui/workspaces/${workspaceId}/dispatches/${review}/messages?scope=collaboration`
  const collaborationHistory = await json<{
    root_dispatch_id: string
    messages: Array<{ id: string; text: string; reply_to: string | null }>
  }>(await expectStatus(await request(collaborationHistoryUrl), 200))
  assert.equal(collaborationHistory.root_dispatch_id, task)
  assert.ok(collaborationHistory.messages.some((item) => item.id === historyQuestion.id))
  const historicalAnswer = collaborationHistory.messages.find(
    (item) => item.text === 'C is a compatibility requirement'
  )
  assert.ok(historicalAnswer)
  assert.equal(historicalAnswer.reply_to, historyQuestion.id)
  const afterQuestion = await json<{ messages: Array<{ id: string }> }>(
    await expectStatus(
      await request(`${collaborationHistoryUrl}&after_message_id=${historyQuestion.id}`),
      200
    )
  )
  assert.ok(afterQuestion.messages.some((item) => item.id === historicalAnswer.id))
  assert.ok(!afterQuestion.messages.some((item) => item.id === historyQuestion.id))
  pass('UI collaboration history joins cross-dispatch question/answer and advances by message ID')
  const obsoleteSource = await send('Bob', 'inquiry later cancelled', task)
  await message(bob, task, 'question', 'Obsolete historical question', {
    source_dispatch_id: obsoleteSource,
  })
  const obsoleteQuestion = (await inbox(alice, task)).messages.find(
    (event) => event.text === 'Obsolete historical question'
  )
  assert.ok(obsoleteQuestion)
  await outputMessageEnvelope(alice, task, 'Obsolete historical question')
  await eventually(async () =>
    assert.equal(
      (await inbox(alice, task)).messages.find((event) => event.id === obsoleteQuestion.id)
        ?.delivery_state,
      'delivered'
    )
  )
  await team(orchestrator, 'cancel', { dispatch_id: obsoleteSource, reason: 'inquiry withdrawn' })
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await start(alice)
  const afterRetirement = await send('Alice', 'verify runnable after retired inquiry')
  await outputHas(alice, afterRetirement)
  const freshOutput = await json<{ output: string }>(
    await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}`), 200)
  )
  assert.ok(!freshOutput.output.includes(obsoleteQuestion.id))
  const actions = await json<{ attention: Array<{ message_id?: string }> }>(
    await expectStatus(await request(`/api/ui/workspaces/${workspaceId}/action-center`), 200)
  )
  assert.ok(!actions.attention.some((item) => item.message_id === obsoleteQuestion.id))
  await report(alice, afterRetirement)
  pass('cancelled historical inquiry is absent from restart instructions and Action Center')
  const fix = await send('Alice', 'fix review findings', review)
  const related = await inbox(bob, review)
  assert.ok(related.related_dispatches.some((row) => row.id === task))
  assert.ok(related.related_dispatches.some((row) => row.id === fix))
  await message(bob, fix, 'note', 'Review finding: preserve empty input', {
    source_dispatch_id: review,
  })
  await outputMessageEnvelope(alice, fix, 'Review finding: preserve empty input')
  assert.ok((await inbox(alice, fix)).required_seen_seq > 0)
  await team(eve, 'message', { dispatch_id: fix, kind: 'note', text: 'unauthorized' }, 403)
  await team(eve, 'messages', { dispatch_id: fix }, 403)
  await team(eve, 'report', { dispatch_id: fix, result: 'forged' }, 409)
  await team(bob, 'send', { to: 'Eve', text: 'unauthorized delegation' }, 403)
  await team(
    alice,
    'message',
    { dispatch_id: fix, source_dispatch_id: review, kind: 'note', text: 'forged source' },
    403
  )
  await report(alice, fix, (await inbox(alice, fix)).required_seen_seq)
  await report(bob, review, (await inbox(bob, review)).required_seen_seq)
  await state(task, 'reported')
  await state(fix, 'reported')
  pass(
    'related review/fix has distinct immutable responsibility; peer delivery and permission boundaries'
  )

  const recentReports = await json<Row[]>(
    await expectStatus(
      await request(`/api/ui/workspaces/${workspaceId}/dispatches?state=reported&reported_since=0`),
      200
    )
  )
  assert.ok(recentReports.some((row) => row.id === task))
  assert.ok(recentReports.every((row) => row.state === 'reported'))
  const futureReports = await json<Row[]>(
    await expectStatus(
      await request(
        `/api/ui/workspaces/${workspaceId}/dispatches?state=reported&reported_since=${Date.now() + 60000}`
      ),
      200
    )
  )
  assert.deepEqual(futureReports, [])
  const recentPage = await json<Row[]>(
    await expectStatus(
      await request(
        `/api/ui/workspaces/${workspaceId}/dispatches?state=reported&reported_since=0&limit=1&offset=1`
      ),
      200
    )
  )
  assert.deepEqual(
    recentPage.map((row) => row.id),
    recentReports.slice(1, 2).map((row) => row.id)
  )
  pass('reported-since query filters persisted completion time and paginates consistently')
  const parallelA = await send('Alice', 'parallel module A')
  const parallelB = await send('Bob', 'parallel module B', parallelA)
  await report(bob, parallelB)
  await state(parallelA, 'submitted')
  await state(parallelB, 'reported')
  await team(orchestrator, 'cancel', { dispatch_id: parallelA, reason: 'A no longer needed' })
  await report(alice, parallelA, undefined, 409)
  await team(
    orchestrator,
    'message',
    { dispatch_id: parallelA, kind: 'note', text: 'after cancel' },
    409
  )
  await state(parallelA, 'cancelled')
  pass('parallel branches settle independently; cancelled work cannot receive or report')

  const parked = await send('Alice', 'stopped recipient delivery')
  await outputHas(alice, parked)
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await eventually(async () =>
    assert.equal(
      runtime?.store.listWorkers(workspaceId).find((worker) => worker.id === alice)?.status,
      'stopped'
    )
  )
  await message(orchestrator, parked, 'note', 'deliver after explicit restart')
  await state(parked, 'submitted')
  const parkedMessages = await inbox(orchestrator, parked)
  assert.equal(
    parkedMessages.messages.find((event) => event.text === 'deliver after explicit restart')
      ?.delivery_state,
    'queued'
  )
  await start(alice)
  await outputMessageEnvelope(alice, parked, 'deliver after explicit restart')
  await report(alice, parked, (await inbox(alice, parked)).required_seen_seq)
  pass('stopped member remains stopped until explicit start; queued message replays')

  const scheduleRace = await send('Alice', 'controlled readiness race')
  await outputHas(alice, scheduleRace)
  const oldRun = runtime.store.getActiveRunByAgentId(workspaceId, alice)
  assert.ok(oldRun)
  await oldRun.postStartInputReady
  // Fault-inject scheduling only: the member still uses a real PTY, SQLite and HTTP.
  let rejectOldReadiness: (error: Error) => void = () => {
    throw new Error('readiness gate not installed')
  }
  oldRun.postStartInputReady = new Promise<void>((_, reject) => {
    rejectOldReadiness = reject
  })
  const raceResponse = await json<{ message: { id: string; delivery_state: string } }>(
    await message(orchestrator, scheduleRace, 'note', 'retry after old readiness rejects')
  )
  assert.equal(raceResponse.message.delivery_state, 'delivering')
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await start(alice)
  const replacementRun = runtime.store.getActiveRunByAgentId(workspaceId, alice)
  assert.ok(replacementRun)
  await replacementRun.postStartInputReady
  assert.equal(
    runtime.store
      .listWorkspaceDispatchMessages(workspaceId)
      .find((event) => event.id === raceResponse.message.id)?.deliveryState,
    'delivering'
  )
  rejectOldReadiness(new PtyInactiveError('old run stopped during controlled readiness check'))
  // Do not query messages here: querying would itself request a drain and hide a missed rerun.
  await outputHas(
    alice,
    `<hive-message kind="note" message="${raceResponse.message.id}" dispatch="${scheduleRace}">`
  )
  await report(alice, scheduleRace, (await inbox(alice, scheduleRace)).required_seen_seq)
  pass(
    'controlled old-run readiness failure after real stop/start reruns delivery without polling-triggered drain'
  )

  const source = await send('Bob', 'source of accepted evidence')
  const recipient = await send('Alice', 'recipient of accepted evidence', source)
  await outputHas(alice, recipient)
  await message(alice, source, 'question', 'Need answer before source closes', {
    source_dispatch_id: recipient,
  })
  const sourceQuestion = (await inbox(bob, source)).messages.find(
    (event) => event.text === 'Need answer before source closes'
  )
  assert.ok(sourceQuestion)
  await outputMessageEnvelope(bob, source, 'Need answer before source closes')
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await message(bob, recipient, 'answer', 'Accepted answer must survive', {
    source_dispatch_id: source,
    reply_to: sourceQuestion.id,
  })
  await message(bob, recipient, 'note', 'Accepted note must survive', {
    source_dispatch_id: source,
  })
  await message(bob, recipient, 'question', 'Question becomes obsolete', {
    source_dispatch_id: source,
  })
  await team(orchestrator, 'cancel', {
    dispatch_id: source,
    reason: 'source ended after evidence accepted',
  })
  const queuedEvidence = await inbox(orchestrator, recipient)
  assert.equal(
    queuedEvidence.messages.find((event) => event.text === 'Accepted answer must survive')
      ?.delivery_state,
    'queued'
  )
  assert.equal(
    queuedEvidence.messages.find((event) => event.text === 'Accepted note must survive')
      ?.delivery_state,
    'queued'
  )
  assert.equal(
    queuedEvidence.messages.find((event) => event.text === 'Question becomes obsolete')
      ?.delivery_state,
    'cancelled'
  )
  await start(alice)
  await outputMessageEnvelope(alice, recipient, 'Accepted answer must survive')
  await outputMessageEnvelope(alice, recipient, 'Accepted note must survive')
  await report(alice, recipient, (await inbox(alice, recipient)).required_seen_seq)
  await outputHas(orchestrator, `completed ${recipient}`)
  pass('accepted answer/note survive source cancellation; obsolete question is retired')

  const cancelTarget = await send('Alice', 'cancel queued target')
  await outputHas(alice, cancelTarget)
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await message(orchestrator, cancelTarget, 'note', 'Must not deliver after target cancel')
  await team(orchestrator, 'cancel', {
    dispatch_id: cancelTarget,
    reason: 'target cancelled before delivery',
  })
  await team(
    orchestrator,
    'message',
    { dispatch_id: cancelTarget, kind: 'question', text: 'cancelled history inquiry' },
    409
  )
  assert.equal((await inbox(orchestrator, cancelTarget)).messages[0]?.delivery_state, 'cancelled')
  await start(alice)
  assert.equal((await inbox(orchestrator, cancelTarget)).messages[0]?.delivery_state, 'cancelled')
  pass('target cancellation retires queued delivery and forbids historical questions')

  const recovery = await send('Alice', 'survive runtime restart')
  await outputHas(alice, recovery)
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await message(orchestrator, recovery, 'note', 'durable requirement')
  await message(orchestrator, recovery, 'note', 'persisted in-flight requirement')
  await outputHas(orchestrator, `completed ${parked}`)
  const saved = await inbox(orchestrator, recovery)
  assert.ok(saved.messages.every((event) => event.delivery_state === 'queued'))
  await runtime.close()
  runtime = undefined
  // Seed the exact durable state of a process that died after claiming delivery.
  const crashedDb = new BetterSqlite3(join(root, 'runtime.sqlite'))
  try {
    const inFlight = saved.messages.find(
      (event) => event.text === 'persisted in-flight requirement'
    )
    assert.ok(inFlight)
    assert.equal(
      crashedDb
        .prepare("UPDATE dispatch_message_outbox SET state='delivering' WHERE message_id=?")
        .run(inFlight.id).changes,
      1
    )
  } finally {
    crashedDb.close()
  }
  runtime = await runHiveCommand(['--port', '0'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, ...members]) await start(actor)
  await outputMessageEnvelope(alice, recovery, 'durable requirement')
  await outputMessageEnvelope(alice, recovery, 'persisted in-flight requirement')
  for (const event of saved.messages)
    await outputHas(
      alice,
      `<hive-message kind="note" message="${event.id}" dispatch="${recovery}">`
    )
  await eventually(async () =>
    assert.ok(
      (await inbox(alice, recovery)).messages.every((event) => event.delivery_state === 'delivered')
    )
  )
  const recovered = await inbox(alice, recovery)
  assert.equal(recovered.required_seen_seq, saved.required_seen_seq)
  assert.deepEqual(
    recovered.messages.map((event) => event.id),
    saved.messages.map((event) => event.id)
  )
  await report(alice, recovery, undefined, 409)
  await report(alice, recovery, recovered.required_seen_seq)
  await state(recovery, 'reported')
  await outputHas(orchestrator, `completed ${recovery}`)
  pass(
    'SQLite restart replays queued and seeded in-flight messages preserving identities and completion barrier'
  )

  const invalidAuth = await request('/api/team/messages', {
    project_id: workspaceId,
    from_agent_id: alice,
    token: 'forged',
    dispatch_id: task,
  })
  await expectStatus(invalidAuth, 401)
  const foreignPath = join(root, 'foreign')
  await mkdir(foreignPath)
  const foreign = await json<{ id: string }>(
    await expectStatus(
      await request('/api/workspaces', {
        name: 'Foreign',
        path: foreignPath,
        autostart_orchestrator: false,
      }),
      201
    )
  )
  await expectStatus(
    await request('/api/team/messages', {
      project_id: foreign.id,
      from_agent_id: alice,
      token: runtime.store.peekAgentToken(alice),
      dispatch_id: task,
    }),
    401
  )
  const workers = runtime.store.listWorkers(workspaceId)
  assert.deepEqual(workers.map((worker) => worker.id).sort(), [...members].sort())
  for (const actor of members) {
    const config = runtime.store.peekAgentLaunchConfig(workspaceId, actor)
    assert.equal(config?.command, process.execPath)
    assert.deepEqual(config?.args, [fixture, '--model', 'user-selected-selfcheck'])
  }
  pass(
    'cross-workspace and token isolation; user-created members and launch configuration preserved'
  )
  const deleteSource = await send('Eve', 'deleted source')
  const survivingTarget = await send('Alice', 'target survives member deletion', deleteSource)
  await outputHas(alice, survivingTarget)
  await outputHas(eve, deleteSource)
  await expectStatus(await request(`/api/runtime/runs/${runs.get(alice)}/stop`, {}), 202)
  await message(eve, survivingTarget, 'note', 'Accepted note survives source deletion', {
    source_dispatch_id: deleteSource,
  })
  await expectStatus(
    await fetch(`${base()}/api/workspaces/${workspaceId}/workers/${eve}`, {
      method: 'DELETE',
      headers: { cookie },
      signal: AbortSignal.timeout(15000),
    }),
    204
  )
  await start(alice)
  await outputMessageEnvelope(alice, survivingTarget, 'Accepted note survives source deletion')
  await report(alice, survivingTarget, (await inbox(alice, survivingTarget)).required_seen_seq)
  await outputHas(orchestrator, `completed ${survivingTarget}`)
  assert.ok(!runtime.store.listWorkers(workspaceId).some((worker) => worker.id === eve))
  pass('accepted note survives deletion of source member')
  const receipt = {
    outcome: 'passed',
    checks: passed,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    node: process.version,
    command: 'pnpm exec tsx scripts/check-team-collaboration.ts',
    scope:
      'deterministic real HTTP SQLite PTY CLI protocol; real-model product acceptance remains separate',
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2))
} catch (error) {
  await writeFile(
    receiptPath,
    `${JSON.stringify({ outcome: 'failed', checks: passed, started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  )
  throw error
} finally {
  try {
    await runtime?.close()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = oldDataDir
    await rm(root, { recursive: true, force: true })
  }
}
