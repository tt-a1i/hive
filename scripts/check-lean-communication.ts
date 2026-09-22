/** Real CLI/HTTP/SQLite/PTY scenario check; passive members, no provider/model calls. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { runHiveCommand } from '../src/cli/hive.js'
import { waitForTeamResult } from '../src/cli/team-question.js'
import Database from '../src/server/sqlite.js'

const directory = await mkdtemp(join(tmpdir(), 'hive-lean-communication-'))
const previousDataDir = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = directory
let runtime: Awaited<ReturnType<typeof runHiveCommand>> | undefined
let cookie = ''
let workspaceId = ''
const processes = new Set<ReturnType<typeof spawn>>()
const request = async (path: string, body?: object, expected = body ? 202 : 200) => {
  const response = await fetch(`http://127.0.0.1:${runtime?.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, expected, await response.clone().text())
  return response
}
const identity = (actor: string) => ({
  project_id: workspaceId,
  from_agent_id: actor,
  token: runtime?.store.peekAgentToken(actor),
})
const team = (actor: string, command: string, body: object, expected = 202) =>
  request(`/api/team/${command}`, { ...identity(actor), ...body }, expected)
const cli = (actor: string, args: string[], stdin = '') => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
    env: {
      ...process.env,
      HIVE_PORT: String(runtime?.port),
      HIVE_PROJECT_ID: workspaceId,
      HIVE_AGENT_ID: actor,
      HIVE_AGENT_TOKEN: runtime?.store.peekAgentToken(actor),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  })
  processes.add(child)
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        processes.delete(child)
        resolve({ code, stdout, stderr })
      })
    }
  )
  child.stdin.end(stdin)
  return { result, stderr: () => stderr }
}
const jsonResult = async (pending: ReturnType<typeof cli>) => {
  const result = await pending.result
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const savedQuestion = async (pending: ReturnType<typeof cli>) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const id = pending.stderr().match(/Question saved: ([\w-]+)\./u)?.[1]
    if (id) return id
    await setTimeout(10)
  }
  assert.fail(`No durable receipt: ${pending.stderr()}`)
}
const startMember = async (actor: string) => {
  const run = await (
    await request(
      `/api/workspaces/${workspaceId}/agents/${actor}/start`,
      { hive_port: String(runtime?.port) },
      201
    )
  ).json()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const data = await (await request(`/api/runtime/runs/${run.run_id}`)).json()
    if (String(data.output).includes('PASSIVE_READY')) return run.run_id as string
    await setTimeout(20)
  }
  assert.fail('Real PTY did not enter raw mode')
}
try {
  const passive = join(directory, 'passive.cjs')
  await writeFile(
    passive,
    "process.stdin.setRawMode(true); process.stdout.write('PASSIVE_READY\\n'); process.stdin.on('data', data => process.stdout.write(data))\n"
  )
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  workspaceId = (
    await (
      await request(
        '/api/workspaces',
        {
          name: 'Lean communication',
          path: directory,
          autostart_orchestrator: false,
        },
        201
      )
    ).json()
  ).id
  const orchestrator = `${workspaceId}:orchestrator`
  const alice = (
    await (
      await request(`/api/workspaces/${workspaceId}/workers`, { name: 'Alice', role: 'coder' }, 201)
    ).json()
  ).id
  const bob = (
    await (
      await request(
        `/api/workspaces/${workspaceId}/workers`,
        { name: 'Bob', role: 'reviewer' },
        201
      )
    ).json()
  ).id
  const outsider = (
    await (
      await request(
        `/api/workspaces/${workspaceId}/workers`,
        { name: 'Other', role: 'tester' },
        201
      )
    ).json()
  ).id
  const runs = new Map<string, string>()
  for (const actor of [orchestrator, alice, bob, outsider]) {
    await request(
      `/api/workspaces/${workspaceId}/agents/${actor}/config`,
      { command: process.execPath, args: [passive] },
      204
    )
    runs.set(actor, await startMember(actor))
  }
  const author = (
    await (await team(orchestrator, 'send', { to: 'Alice', text: 'Implement' })).json()
  ).dispatch_id
  const review = (
    await (
      await team(orchestrator, 'send', {
        to: 'Bob',
        text: 'Review',
        related_to_dispatch_id: author,
      })
    ).json()
  ).dispatch_id

  const waiting = cli(alice, [
    'ask',
    '--dispatch',
    author,
    '--to',
    'orchestrator',
    '--wait',
    '5',
    'Which API?',
  ])
  const questionId = await savedQuestion(waiting)
  await team(outsider, 'question', { question_id: questionId }, 403)
  await team(outsider, 'reply', { question_id: questionId, text: 'wrong actor' }, 403)
  await team(alice, 'reply', { question_id: questionId, text: 'self answer' }, 403)
  const answer = await jsonResult(cli(orchestrator, ['reply', questionId, '--stdin'], 'Use v2'))
  const answered = await jsonResult(waiting)
  assert.equal(answered.status, 'answered')
  assert.equal(answered.timed_out, false)
  assert.equal(answered.question_id, questionId)
  assert.equal(answered.answers[0].text, 'Use v2')
  assert.equal(answer.message.recipient_agent_id, alice)
  assert.equal(answer.message.dispatch_id, author)
  const resumed = await jsonResult(cli(alice, ['ask', '--resume', questionId, '--wait', '0']))
  assert.equal(resumed.answers[0].id, answer.message.id)
  assert.equal(
    runtime.store.listWorkspaceDispatchMessages(workspaceId).filter((m) => m.kind === 'question')
      .length,
    1
  )
  assert.equal(runtime.store.getWorker(workspaceId, alice).pendingTaskCount, 1)
  await team(alice, 'report', { dispatch_id: author, seen_seq: 0, result: 'stale' }, 409)
  await team(alice, 'report', {
    dispatch_id: author,
    seen_seq: answer.message.sequence,
    result: 'Implemented',
  })

  const history = await jsonResult(
    cli(bob, ['ask', '--dispatch', author, '--from-dispatch', review, '--wait', '0', 'Why v2?'])
  )
  assert.equal(history.status, 'pending')
  const historicalReply = await jsonResult(
    cli(alice, ['reply', history.question_id, 'Evidence for v2'])
  )
  assert.equal(historicalReply.message.dispatch_id, review)
  assert.equal(historicalReply.message.source_dispatch_id, author)
  assert.equal(historicalReply.message.recipient_agent_id, bob)
  assert.equal(
    (await jsonResult(cli(bob, ['ask', '--resume', history.question_id, '--wait', '0']))).answers[0]
      .text,
    'Evidence for v2'
  )
  assert.equal(runtime.store.getWorker(workspaceId, alice).pendingTaskCount, 0)

  const cursor = historicalReply.message.sequence
  let reads = 0
  let note: { message: { id: string; sequence: number } } | undefined
  const updateStart = performance.now()
  const { result: inbox } = await waitForTeamResult(
    async (signal) => {
      const response = await fetch(`http://127.0.0.1:${runtime?.port}/api/team/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ ...identity(bob), dispatch_id: review, after_seq: cursor }),
      })
      assert.equal(response.status, 200)
      const value = await response.json()
      reads += 1
      if (reads === 1) {
        assert.deepEqual(value.messages, [])
        // Only publish after the real first empty read. A no-wait implementation fails.
        note = await (
          await team(orchestrator, 'message', {
            dispatch_id: review,
            kind: 'note',
            text: 'Retain zero',
          })
        ).json()
      }
      return value
    },
    (value) => value.messages.length > 0,
    3
  )
  assert.ok(reads >= 2)
  assert.ok(performance.now() - updateStart >= 900)
  assert.ok(note)
  assert.deepEqual(
    inbox.messages.map((m: { id: string }) => m.id),
    [note.message.id]
  )
  assert.equal(inbox.required_seen_seq, note.message.sequence)
  const timeoutStart = performance.now()
  const noUpdate = await jsonResult(
    cli(bob, [
      'messages',
      '--dispatch',
      review,
      '--after',
      String(note.message.sequence),
      '--wait',
      '1',
    ])
  )
  assert.deepEqual(noUpdate.messages, [])
  assert.equal(noUpdate.timed_out, true)
  assert.ok(performance.now() - timeoutStart >= 900)
  assert.ok(performance.now() - timeoutStart < 5000)
  const invalidWait = await cli(bob, ['messages', '--dispatch', review, '--wait', '1']).result
  assert.notEqual(invalidWait.code, 0)

  const cancelled = await jsonResult(
    cli(bob, [
      'ask',
      '--dispatch',
      review,
      '--to',
      'orchestrator',
      '--wait',
      '0',
      'May I continue?',
    ])
  )
  await team(orchestrator, 'cancel', { dispatch_id: review, reason: 'Stop this review' })
  assert.equal(
    (await jsonResult(cli(bob, ['ask', '--resume', cancelled.question_id, '--wait', '1']))).status,
    'closed'
  )
  await team(orchestrator, 'reply', { question_id: cancelled.question_id, text: 'Too late' }, 409)
  const afterCancel =
    runtime.store
      .listWorkspaceDispatchMessages(workspaceId)
      .filter((m) => m.dispatchId === review)
      .at(-1)?.sequence ?? 0
  const closedStart = performance.now()
  const closedInbox = await jsonResult(
    cli(bob, ['messages', '--dispatch', review, '--after', String(afterCancel), '--wait', '5'])
  )
  assert.deepEqual(closedInbox.messages, [])
  assert.equal(closedInbox.timed_out, false)
  assert.ok(performance.now() - closedStart < 4000)
  await team(orchestrator, 'question', { question_id: questionId, token: 'invalid' }, 401)
  const removedRecipient = await jsonResult(
    cli(orchestrator, [
      'ask',
      '--dispatch',
      author,
      '--wait',
      '0',
      'Historical clarification before removal',
    ])
  )
  runtime.store.deleteWorker(workspaceId, alice)
  assert.equal(
    (
      await jsonResult(
        cli(orchestrator, ['ask', '--resume', removedRecipient.question_id, '--wait', '0'])
      )
    ).status,
    'closed'
  )

  const next = (
    await (
      await team(orchestrator, 'send', { to: 'Bob', text: 'Continue in new responsibility' })
    ).json()
  ).dispatch_id
  const durable = await jsonResult(
    cli(bob, [
      'ask',
      '--dispatch',
      next,
      '--to',
      'orchestrator',
      '--wait',
      '1',
      'Persist this question',
    ])
  )
  assert.equal(durable.status, 'pending')
  assert.equal(durable.timed_out, true)
  const beforeRestart = runtime.store.listWorkspaceDispatchMessages(workspaceId).length
  await runtime.close()
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, bob]) await startMember(actor)
  const afterRestart = await jsonResult(
    cli(bob, ['ask', '--resume', durable.question_id, '--wait', '0'])
  )
  assert.equal(afterRestart.question.text, 'Persist this question')
  assert.equal(afterRestart.status, 'pending')
  assert.equal(runtime.store.listWorkspaceDispatchMessages(workspaceId).length, beforeRestart)
  await jsonResult(cli(orchestrator, ['reply', durable.question_id, 'Recovered answer']))
  assert.equal(
    (await jsonResult(cli(bob, ['ask', '--resume', durable.question_id, '--wait', '0']))).answers[0]
      .text,
    'Recovered answer'
  )
  await startMember(outsider)
  const carol = (
    await (
      await request(`/api/workspaces/${workspaceId}/workers`, { name: 'Carol', role: 'coder' }, 201)
    ).json()
  ).id
  const dave = (
    await (
      await request(`/api/workspaces/${workspaceId}/workers`, { name: 'Dave', role: 'tester' }, 201)
    ).json()
  ).id
  for (const actor of [carol, dave]) {
    await request(
      `/api/workspaces/${workspaceId}/agents/${actor}/config`,
      { command: process.execPath, args: [passive] },
      204
    )
    await startMember(actor)
  }
  const delegatedRoot = (
    await (
      await team(orchestrator, 'send', { to: 'Bob', text: 'Own a bounded delegation tree' })
    ).json()
  ).dispatch_id
  const child = await jsonResult(
    cli(bob, ['delegate', 'Other', '--from-dispatch', delegatedRoot, 'Independent child'])
  )
  const grandchild = await jsonResult(
    cli(outsider, [
      'delegate',
      'Carol',
      '--from-dispatch',
      child.dispatch_id,
      'Independent grandchild',
    ])
  )
  await team(
    outsider,
    'delegate',
    { from_dispatch_id: child.dispatch_id, to: 'Bob', text: 'Ancestor cycle' },
    409
  )
  await team(
    carol,
    'delegate',
    { from_dispatch_id: grandchild.dispatch_id, to: 'Dave', text: 'Too deep' },
    409
  )
  await team(
    carol,
    'delegate',
    { from_dispatch_id: delegatedRoot, to: 'Dave', text: 'Not my responsibility' },
    403
  )
  const concurrent = await Promise.all(
    [1, 2, 3].map(async (index) => {
      const response = await fetch(`http://127.0.0.1:${runtime?.port}/api/team/delegate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...identity(bob),
          from_dispatch_id: delegatedRoot,
          to: 'Dave',
          text: `Parallel child ${index}`,
        }),
      })
      return { status: response.status, body: await response.json() }
    })
  )
  assert.equal(concurrent.filter((item) => item.status === 202).length, 2)
  assert.equal(concurrent.filter((item) => item.status === 409).length, 1)
  await team(bob, 'report', { dispatch_id: delegatedRoot, result: 'Children still open' }, 409)
  const pendingBeforeForbidden = [outsider, carol, dave].map(
    (id) => runtime.store.getWorker(workspaceId, id).pendingTaskCount
  )
  await team(carol, 'cancel', { dispatch_id: child.dispatch_id, reason: 'Not my child' }, 403)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === child.dispatch_id)?.status,
    'submitted'
  )
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === grandchild.dispatch_id)?.status,
    'submitted'
  )
  assert.deepEqual(
    [outsider, carol, dave].map((id) => runtime.store.getWorker(workspaceId, id).pendingTaskCount),
    pendingBeforeForbidden
  )
  const carolPending = runtime.store.getWorker(workspaceId, carol).pendingTaskCount
  await team(bob, 'cancel', { dispatch_id: child.dispatch_id, reason: 'Cancel my child tree' })
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === grandchild.dispatch_id)?.status,
    'cancelled'
  )
  assert.equal(runtime.store.getWorker(workspaceId, carol).pendingTaskCount, carolPending - 1)
  const davePending = runtime.store.getWorker(workspaceId, dave).pendingTaskCount
  await team(orchestrator, 'cancel', { dispatch_id: delegatedRoot, reason: 'Cancel parent' })
  assert.equal(runtime.store.getWorker(workspaceId, dave).pendingTaskCount, davePending - 2)
  for (const item of concurrent.filter((item) => item.status === 202))
    assert.equal(
      runtime.store.listDispatches(workspaceId).find((d) => d.id === item.body.dispatch_id)?.status,
      'cancelled'
    )

  // Exercise both serial orders and concurrent HTTP requests against the same ledger.
  for (const order of ['report-first', 'cancel-first', 'concurrent']) {
    const parent = (await (await team(orchestrator, 'send', { to: 'Bob', text: order })).json())
      .dispatch_id
    const delegated = await jsonResult(
      cli(bob, ['delegate', 'Other', '--from-dispatch', parent, order])
    )
    const pendingBefore = runtime.store.getWorker(workspaceId, outsider).pendingTaskCount
    const submitReport = () =>
      fetch(`http://127.0.0.1:${runtime?.port}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...identity(outsider),
          dispatch_id: delegated.dispatch_id,
          result: order,
          status: 'success',
        }),
        signal: AbortSignal.timeout(10000),
      })
    const cancelParent = () => team(orchestrator, 'cancel', { dispatch_id: parent, reason: order })
    let reportResponse: Response
    if (order === 'report-first') {
      reportResponse = await submitReport()
      await cancelParent()
    } else if (order === 'cancel-first') {
      await cancelParent()
      reportResponse = await submitReport()
    } else [reportResponse] = await Promise.all([submitReport(), cancelParent()])
    const childState = runtime.store
      .listDispatches(workspaceId)
      .find((d) => d.id === delegated.dispatch_id)
    assert.equal(reportResponse.status, childState?.status === 'reported' ? 202 : 409)
    if (order === 'report-first') assert.equal(childState?.status, 'reported')
    if (order === 'cancel-first') assert.equal(childState?.status, 'cancelled')
    assert.equal(
      runtime.store.listDispatches(workspaceId).find((d) => d.id === parent)?.status,
      'cancelled'
    )
    assert.equal(runtime.store.getWorker(workspaceId, outsider).pendingTaskCount, pendingBefore - 1)
    const scenarioStore = runtime.store
    const notes = () =>
      scenarioStore
        .listWorkspaceDispatchMessages(workspaceId)
        .filter((m) => m.sourceDispatchId === delegated.dispatch_id)
    assert.equal(notes().length, childState?.status === 'reported' ? 1 : 0)
    const count = notes().length
    await team(
      outsider,
      'report',
      { dispatch_id: delegated.dispatch_id, result: 'Late duplicate' },
      409
    )
    assert.equal(notes().length, count)
    assert.equal(runtime.store.getWorker(workspaceId, outsider).pendingTaskCount, pendingBefore - 1)
  }
  // A real SQLite failure must roll back both termination and its parent input.
  const faultParent = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Atomic child result' })).json()
  ).dispatch_id
  const faultChild = await jsonResult(
    cli(bob, ['delegate', 'Other', '--from-dispatch', faultParent, 'Fault injection'])
  )
  const faultPending = runtime.store.getWorker(workspaceId, outsider).pendingTaskCount
  const faultDb = new Database(join(directory, 'runtime.sqlite'))
  try {
    faultDb.exec(`CREATE TRIGGER fail_child_result BEFORE INSERT ON dispatch_messages
      WHEN NEW.source_dispatch_id = '${faultChild.dispatch_id}' AND NEW.dispatch_id = '${faultParent}'
      BEGIN SELECT RAISE(ABORT, 'selfcheck child result write failure'); END`)
    await team(
      outsider,
      'report',
      { dispatch_id: faultChild.dispatch_id, result: 'Evidence', status: 'success' },
      500
    )
    assert.equal(
      runtime.store.listDispatches(workspaceId).find((d) => d.id === faultChild.dispatch_id)
        ?.status,
      'submitted'
    )
    assert.equal(runtime.store.getWorker(workspaceId, outsider).pendingTaskCount, faultPending)
    assert.equal(
      runtime.store
        .listWorkspaceDispatchMessages(workspaceId)
        .filter((m) => m.sourceDispatchId === faultChild.dispatch_id).length,
      0
    )
    faultDb.exec('DROP TRIGGER fail_child_result')
    await team(outsider, 'report', {
      dispatch_id: faultChild.dispatch_id,
      result: 'Evidence',
      status: 'success',
    })
    assert.equal(runtime.store.getWorker(workspaceId, outsider).pendingTaskCount, faultPending - 1)
    const outputs = runtime.store
      .listWorkspaceDispatchMessages(workspaceId)
      .filter((m) => m.sourceDispatchId === faultChild.dispatch_id)
    assert.equal(outputs.length, 1)
    await team(bob, 'report', {
      dispatch_id: faultParent,
      result: 'Verified atomic result',
      seen_seq: outputs[0].sequence,
      status: 'success',
    })
  } finally {
    faultDb.close()
  }
  const ephemeral = runtime.store.addWorkerWithLaunch(
    workspaceId,
    { name: 'Temporary', role: 'tester', ephemeral: true, spawnedBy: 'orchestrator' },
    { command: process.execPath, args: [passive] }
  )
  await startMember(ephemeral.id)
  const ephemRun = runtime.store.getActiveRunByAgentId(workspaceId, ephemeral.id)
  assert.ok(ephemRun)
  const ephemParent = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Cancel temporary leaf' })).json()
  ).dispatch_id
  const ephemChild = await jsonResult(
    cli(bob, ['delegate', 'Temporary', '--from-dispatch', ephemParent, 'Temporary work'])
  )
  await team(orchestrator, 'cancel', {
    dispatch_id: ephemParent,
    reason: 'No remaining temporary work',
  })
  const ephemDeadline = Date.now() + 5000
  while (
    Date.now() < ephemDeadline &&
    runtime.store.listWorkers(workspaceId).some((w) => w.id === ephemeral.id)
  )
    await setTimeout(20)
  assert.equal(
    runtime.store.listWorkers(workspaceId).some((w) => w.id === ephemeral.id),
    false
  )
  assert.equal(runtime.store.getActiveRunByAgentId(workspaceId, ephemeral.id), undefined)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === ephemChild.dispatch_id)?.status,
    'cancelled'
  )

  const resultRoot = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Collect child result' })).json()
  ).dispatch_id
  const resultChild = await jsonResult(
    cli(bob, ['delegate', 'Other', '--from-dispatch', resultRoot, 'Return evidence'])
  )
  const parentRun = runtime.store.getActiveRunByAgentId(workspaceId, bob)
  assert.ok(parentRun)
  await request(`/api/runtime/runs/${parentRun.runId}/stop`, {})
  const childReport = await cli(outsider, [
    'report',
    '--dispatch',
    resultChild.dispatch_id,
    '--success',
    'Child evidence',
  ]).result
  assert.equal(childReport.code, 0, childReport.stderr)
  assert.equal(runtime.store.getActiveRunByAgentId(workspaceId, bob), undefined)
  const resultNote = runtime.store
    .listWorkspaceDispatchMessages(workspaceId)
    .find(
      (message) =>
        message.sourceDispatchId === resultChild.dispatch_id && message.dispatchId === resultRoot
    )
  assert.ok(resultNote)
  assert.equal(resultNote.recipientAgentId, bob)
  assert.match(resultNote.text, /outcome=success/u)
  assert.match(resultNote.text, /Child evidence/u)
  const resumedParentRun = await startMember(bob)
  const deliveredDeadline = Date.now() + 5000
  while (Date.now() < deliveredDeadline) {
    const output = await (await request(`/api/runtime/runs/${resumedParentRun}`)).json()
    if (String(output.output).includes('Child evidence')) break
    await setTimeout(20)
  }
  assert.ok(
    String((await (await request(`/api/runtime/runs/${resumedParentRun}`)).json()).output).includes(
      'Child evidence'
    )
  )
  await team(
    bob,
    'report',
    { dispatch_id: resultRoot, result: 'Must read child evidence first' },
    409
  )
  await team(bob, 'report', {
    dispatch_id: resultRoot,
    seen_seq: resultNote.sequence,
    status: 'success',
    result: 'Child evidence checked',
  })
  const budgetRoot = (
    await (
      await team(orchestrator, 'send', { to: 'Bob', text: 'Check lifetime delegation cap' })
    ).json()
  ).dispatch_id
  for (let index = 0; index < 8; index += 1) {
    const delegated = await jsonResult(
      cli(bob, ['delegate', 'Dave', '--from-dispatch', budgetRoot, `Bounded item ${index}`])
    )
    await team(bob, 'cancel', {
      dispatch_id: delegated.dispatch_id,
      reason: 'Item no longer needed',
    })
  }
  await team(bob, 'delegate', { from_dispatch_id: budgetRoot, to: 'Dave', text: 'Ninth item' }, 409)
  await team(orchestrator, 'cancel', { dispatch_id: budgetRoot, reason: 'Budget scenario done' })
  const stoppedRoot = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Check stopped recipient' })).json()
  ).dispatch_id
  const daveRun = runtime.store.getActiveRunByAgentId(workspaceId, dave)
  assert.ok(daveRun)
  await request(`/api/runtime/runs/${daveRun.runId}/stop`, {})
  const parked = await jsonResult(
    cli(bob, ['delegate', 'Dave', '--from-dispatch', stoppedRoot, 'Remain parked'])
  )
  assert.equal(parked.queued, true)
  assert.equal(runtime.store.getActiveRunByAgentId(workspaceId, dave), undefined)
  await team(orchestrator, 'cancel', { dispatch_id: stoppedRoot, reason: 'Cancel stopped child' })
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === parked.dispatch_id)?.status,
    'cancelled'
  )
  assert.equal(runtime.store.getWorker(workspaceId, dave).pendingTaskCount, 0)

  const deletionRoot = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Check removed child' })).json()
  ).dispatch_id
  const deletedChild = await jsonResult(
    cli(bob, ['delegate', 'Carol', '--from-dispatch', deletionRoot, 'Child that will be removed'])
  )
  runtime.store.deleteWorker(workspaceId, carol)
  const deletionDeadline = Date.now() + 5000
  while (
    Date.now() < deletionDeadline &&
    !runtime.store
      .listWorkspaceDispatchMessages(workspaceId)
      .some(
        (m) => m.sourceDispatchId === deletedChild.dispatch_id && m.deliveryState === 'delivered'
      )
  )
    await setTimeout(20)
  const deletedNote = runtime.store
    .listWorkspaceDispatchMessages(workspaceId)
    .find((m) => m.sourceDispatchId === deletedChild.dispatch_id)
  assert.equal(deletedNote?.deliveryState, 'delivered')
  assert.match(deletedNote?.text ?? '', /Worker removed/u)
  await team(bob, 'report', {
    dispatch_id: deletionRoot,
    seen_seq: deletedNote?.sequence,
    result: 'Removal handled',
    status: 'failed',
  })
  const independent = (
    await (await team(orchestrator, 'send', { to: 'Other', text: 'Independent expertise' })).json()
  ).dispatch_id
  const peers = await jsonResult(cli(bob, ['peers']))
  assert.ok(
    peers.members.some(
      (member: { id: string; dispatches: { id: string }[] }) =>
        member.id === outsider && member.dispatches.some((d) => d.id === independent)
    )
  )
  await team(bob, 'messages', { dispatch_id: independent }, 403)
  await team(
    bob,
    'message',
    {
      dispatch_id: independent,
      source_dispatch_id: next,
      kind: 'note',
      text: 'Cannot reassign across roots',
    },
    403
  )
  const crossRoot = await jsonResult(
    cli(bob, [
      'ask',
      '--dispatch',
      independent,
      '--from-dispatch',
      next,
      '--wait',
      '0',
      'Need your expertise',
    ])
  )
  const crossReply = await jsonResult(
    cli(outsider, ['reply', crossRoot.question_id, 'Fact from other task'])
  )
  assert.equal(crossReply.message.dispatch_id, next)
  assert.equal(crossReply.message.recipient_agent_id, bob)
  assert.equal(
    (await jsonResult(cli(bob, ['ask', '--resume', crossRoot.question_id, '--wait', '0']))).status,
    'answered'
  )

  // Discard the committed cross-root write receipt, recover only from sender history.
  const beforeLost = runtime.store.listWorkspaceDispatchMessages(workspaceId).length
  await team(bob, 'message', {
    dispatch_id: independent,
    source_dispatch_id: next,
    kind: 'question',
    text: 'Lost response recovery',
  })
  const sent = await jsonResult(cli(bob, ['ask', '--list', '--dispatch', next]))
  const recovered = sent.questions.find(
    (q: { text: string }) => q.text === 'Lost response recovery'
  )
  assert.ok(recovered)
  assert.equal(recovered.from_agent_id, bob)
  assert.equal(sent.next_before, null)
  const older = await jsonResult(cli(bob, ['ask', '--list', '--before', recovered.id]))
  assert.equal(
    older.questions.some((q: { id: string }) => q.id === recovered.id),
    false
  )
  const otherHistory = await jsonResult(cli(outsider, ['ask', '--list', '--dispatch', next]))
  assert.equal(
    otherHistory.questions.some((q: { id: string }) => q.id === recovered.id),
    false
  )
  await team(outsider, 'questions', { before_id: recovered.id }, 409)
  await team(bob, 'messages', { dispatch_id: independent }, 403)
  assert.equal(
    (await jsonResult(cli(bob, ['ask', '--resume', recovered.id, '--wait', '0']))).status,
    'pending'
  )
  assert.equal(runtime.store.listWorkspaceDispatchMessages(workspaceId).length, beforeLost + 1)
  await jsonResult(cli(outsider, ['reply', recovered.id, 'Recovered without resending']))

  const noteA = (
    await (
      await team(orchestrator, 'message', { dispatch_id: next, kind: 'note', text: 'Input A' })
    ).json()
  ).message
  const batchA = await jsonResult(cli(bob, ['inbox']))
  assert.ok(batchA.batch_id)
  assert.ok(batchA.messages.some((message: { id: string }) => message.id === noteA.id))
  const noteB = (
    await (
      await team(orchestrator, 'message', {
        dispatch_id: next,
        kind: 'note',
        text: 'Input B after read',
      })
    ).json()
  ).message
  await team(
    bob,
    'report',
    { dispatch_id: next, ack_batch_id: batchA.batch_id, result: 'Must not swallow B' },
    409
  )
  assert.equal((await jsonResult(cli(bob, ['inbox']))).batch_id, batchA.batch_id)
  await team(outsider, 'inbox', { ack_batch_id: batchA.batch_id }, 403)
  await jsonResult(cli(bob, ['inbox', '--ack', batchA.batch_id]))
  const batchB = await jsonResult(cli(bob, ['inbox']))
  assert.notEqual(batchB.batch_id, batchA.batch_id)
  assert.deepEqual(
    batchB.messages.map((message: { id: string }) => message.id),
    [noteB.id]
  )
  await jsonResult(cli(bob, ['inbox', '--ack', batchA.batch_id]))
  assert.equal((await jsonResult(cli(bob, ['inbox']))).batch_id, batchB.batch_id)
  await team(bob, 'report', { dispatch_id: next, result: 'B still unacknowledged' }, 409)
  await runtime.close()
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, bob, outsider]) await startMember(actor)
  const batchAfterRestart = await jsonResult(cli(bob, ['inbox']))
  assert.equal(batchAfterRestart.batch_id, batchB.batch_id)
  assert.deepEqual(
    batchAfterRestart.messages.map((message: { id: string }) => message.id),
    [noteB.id]
  )
  const finalReport = await cli(bob, [
    'report',
    '--dispatch',
    next,
    '--ack',
    batchB.batch_id,
    '--failed',
    'Explicit failed result',
  ]).result
  assert.equal(finalReport.code, 0, finalReport.stderr)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === next)?.outcome,
    'failed'
  )
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === author)?.outcome,
    null
  )
  assert.equal((await jsonResult(cli(bob, ['inbox']))).batch_id, null)
  await runtime.close()
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === next)?.outcome,
    'failed'
  )
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, bob, outsider, dave]) await startMember(actor)
  const removedParentRoot = (
    await (await team(orchestrator, 'send', { to: 'Bob', text: 'Remove delegation owner' })).json()
  ).dispatch_id
  const orphanChild = await jsonResult(
    cli(bob, [
      'delegate',
      'Other',
      '--from-dispatch',
      removedParentRoot,
      'Child to cancel on owner removal',
    ])
  )
  const orphanGrandchild = await jsonResult(
    cli(outsider, [
      'delegate',
      'Dave',
      '--from-dispatch',
      orphanChild.dispatch_id,
      'Grandchild to cancel',
    ])
  )
  const outsiderPending = runtime.store.getWorker(workspaceId, outsider).pendingTaskCount
  runtime.store.deleteWorker(workspaceId, bob)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === orphanChild.dispatch_id)?.status,
    'cancelled'
  )
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === orphanGrandchild.dispatch_id)
      ?.status,
    'cancelled'
  )
  assert.equal(runtime.store.getWorker(workspaceId, outsider).pendingTaskCount, outsiderPending - 1)
  assert.equal(runtime.store.getWorker(workspaceId, dave).pendingTaskCount, 0)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((d) => d.id === independent)?.status,
    'submitted'
  )
  console.log(
    'PASS: ask/reply, mailbox ACK races/restart, cross-root consultation, structured outcomes, delegation limits/cancellation/stopped members/result delivery/owner removal'
  )
} finally {
  for (const child of processes) child.kill()
  try {
    await runtime?.close()
  } finally {
    if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
}
