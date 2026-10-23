/** Real CLI/HTTP/SQLite/PTY question recovery; passive processes only, no model calls. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { runHiveCommand } from '../src/cli/hive.js'
import { createControllerStore } from '../src/server/controller-store.js'
import { openRuntimeDatabase } from '../src/server/runtime-database.js'

interface Message {
  id: string
  text: string
  from_agent_id: string
  recipient_agent_id: string
  dispatch_id: string
  source_dispatch_id: string | null
}
interface QuestionResult {
  question_id: string
  status: 'pending' | 'answered' | 'closed'
  timed_out: boolean
  question: Message
  answers: Message[]
}
const root = await mkdtemp(join(tmpdir(), 'hive-question-recovery-'))
const previousDataDir = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = root
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
const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await setTimeout(20)
  }
  assert.fail(`Timed out: ${label}`)
}
const cli = (actor: string, args: string[], input = '') => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
    env: {
      ...process.env,
      HIVE_PORT: String(runtime?.port),
      HIVE_PROJECT_ID: workspaceId,
      HIVE_AGENT_ID: actor,
      HIVE_AGENT_TOKEN: runtime?.store.peekAgentToken(actor),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  })
  processes.add(child)
  let stdout = ''
  let stderr = ''
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
  child.stdin.end(input)
  return { result, stderr: () => stderr }
}
const json = async <T>(pending: ReturnType<typeof cli>): Promise<T> => {
  const result = await pending.result
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}
const savedId = async (pending: ReturnType<typeof cli>) => {
  await until(
    () => /Question saved: (\S+)\./u.test(pending.stderr()),
    'durable CLI question receipt'
  )
  return pending.stderr().match(/Question saved: (\S+)\./u)?.[1] as string
}
const start = async (actor: string, passive: string, project = workspaceId) => {
  await request(
    `/api/workspaces/${project}/agents/${actor}/config`,
    { command: process.execPath, args: [passive, join(root, `${actor}.stdin`)] },
    204
  )
  const { run_id: runId } = await (
    await request(`/api/workspaces/${project}/agents/${actor}/start`, {}, 201)
  ).json()
  await until(async () => {
    const { output } = await (await request(`/api/runtime/runs/${runId}`)).json()
    return String(output).includes('QUESTION_CHECK_READY')
  }, 'passive real PTY readiness')
}
const send = async (actor: string, to: string, related?: string) => {
  const { dispatch_id: dispatchId } = await (
    await team(actor, 'send', {
      to,
      text: 'Question recovery check',
      ...(related ? { related_to_dispatch_id: related } : {}),
    })
  ).json()
  await until(
    () =>
      Boolean(
        runtime?.store.listDispatches(workspaceId).find((item) => item.id === dispatchId)
          ?.deliveredAt
      ),
    'dispatch delivered to real PTY'
  )
  return dispatchId as string
}
try {
  const passive = join(root, 'passive.cjs')
  await writeFile(
    passive,
    [
      "const fs = require('node:fs')",
      "fs.writeFileSync(process.argv[2], '')",
      'process.stdin.setRawMode(true)',
      "process.stdout.write('QUESTION_CHECK_READY\\n')",
      "process.stdin.on('data', data => fs.appendFileSync(process.argv[2], data))",
    ].join('\n')
  )
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  workspaceId = (
    await (
      await request(
        '/api/workspaces',
        {
          name: 'Question recovery self-check',
          path: root,
          autostart_orchestrator: false,
        },
        201
      )
    ).json()
  ).id
  const orchestrator = `${workspaceId}:orchestrator`
  const workers: string[] = []
  for (const name of ['Alice', 'Bob', 'Carol']) {
    workers.push(
      (
        await (
          await request(
            `/api/workspaces/${workspaceId}/workers`,
            {
              name,
              role: 'coder',
            },
            201
          )
        ).json()
      ).id
    )
  }
  const [alice, bob, carol] = workers as [string, string, string]
  for (const actor of [orchestrator, ...workers]) await start(actor, passive)
  const author = await send(orchestrator, 'Alice')
  const review = await send(orchestrator, 'Bob', author)
  const unrelated = await send(orchestrator, 'Carol')
  const first = cli(
    bob,
    ['ask', '--dispatch', author, '--from-dispatch', review, '--stdin'],
    'Explain the evidence'
  )
  const firstId = await savedId(first)
  const pending = await json<QuestionResult>(first)
  assert.equal(pending.question_id, firstId)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.timed_out, false)
  assert.deepEqual(pending.answers, [])
  await until(
    async () =>
      (await readFile(join(root, `${alice}.stdin`), 'utf8')).includes(
        `Reply: team reply ${firstId} --stdin`
      ),
    'short executable reply command in actual PTY input'
  )
  await team(carol, 'question', { question_id: firstId }, 403)
  await team(carol, 'reply', { question_id: firstId, text: 'Wrong recipient' }, 403)
  await team(bob, 'questions', { before_id: firstId, token: 'invalid' }, 401)
  await team(alice, 'questions', { before_id: firstId }, 409)
  await team(
    bob,
    'message',
    {
      dispatch_id: unrelated,
      source_dispatch_id: review,
      kind: 'question',
      text: 'Cross root denied',
    },
    403
  )
  await team(
    alice,
    'reply',
    { question_id: firstId, text: 'Forged route', dispatch_id: unrelated },
    400
  )
  const reply = await json<{ message: Message }>(
    cli(alice, ['reply', firstId, '--stdin'], 'Use v2')
  )
  assert.equal(reply.message.dispatch_id, review)
  assert.equal(reply.message.source_dispatch_id, author)
  assert.equal(reply.message.recipient_agent_id, bob)
  const answered = await json<QuestionResult>(cli(bob, ['ask', '--resume', firstId]))
  assert.equal(answered.status, 'answered')
  assert.deepEqual(
    answered.answers.map((item) => item.id),
    [reply.message.id]
  )
  assert.equal(runtime.store.getWorker(workspaceId, bob).pendingTaskCount, 1)

  // Discard the write receipt, then recover its ID from sender-only history.
  await team(bob, 'message', {
    dispatch_id: review,
    recipient: 'orchestrator',
    kind: 'question',
    text: 'Discarded receipt probe',
  })
  const own = await json<{ questions: Message[]; next_before: string | null }>(
    cli(bob, ['ask', '--list'])
  )
  assert.ok(own.questions.every((item) => item.from_agent_id === bob))
  const lost = own.questions.find((item) => item.text === 'Discarded receipt probe')
  assert.ok(lost)
  const count = runtime.store.listWorkspaceDispatchMessages(workspaceId).length
  const waiting = cli(
    bob,
    ['ask', '--dispatch', review, '--to', 'orchestrator', '--wait', '10', '--stdin'],
    'Wait for a decision'
  )
  const waitingId = await savedId(waiting)
  const beforeAnswer = await (await team(bob, 'question', { question_id: waitingId }, 200)).json()
  assert.equal(beforeAnswer.status, 'pending')
  assert.deepEqual(beforeAnswer.answers, [])
  await json(cli(orchestrator, ['reply', waitingId, '--stdin'], 'Proceed'))
  const afterAnswer = await json<QuestionResult>(waiting)
  assert.equal(afterAnswer.status, 'answered')
  assert.equal(afterAnswer.timed_out, false)
  assert.equal(afterAnswer.answers[0]?.text, 'Proceed')
  const timeoutRequest = cli(bob, [
    'ask',
    '--dispatch',
    review,
    '--to',
    'orchestrator',
    '--wait',
    '1',
    'Pending timeout',
  ])
  await savedId(timeoutRequest)
  const timeoutStart = performance.now()
  const timeout = await json<QuestionResult>(timeoutRequest)
  assert.equal(timeout.status, 'pending')
  assert.equal(timeout.timed_out, true)
  assert.ok(performance.now() - timeoutStart >= 850)
  assert.ok(performance.now() - timeoutStart < 3000)
  const beforeRestart = runtime.store.listWorkspaceDispatchMessages(workspaceId).length
  assert.equal(beforeRestart, count + 3)
  await runtime.close()
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  for (const actor of [orchestrator, ...workers]) await start(actor, passive)
  const recovered = await json<QuestionResult>(cli(bob, ['ask', '--resume', lost.id]))
  assert.equal(recovered.status, 'pending')
  assert.equal(recovered.question.text, lost.text)
  assert.equal(
    (await json<QuestionResult>(cli(bob, ['ask', '--resume', firstId]))).answers[0]?.id,
    reply.message.id
  )
  assert.equal(runtime.store.listWorkspaceDispatchMessages(workspaceId).length, beforeRestart)

  await mkdir(join(root, 'other'))
  const another = (
    await (
      await request(
        '/api/workspaces',
        {
          name: 'Other isolated workspace',
          path: join(root, 'other'),
          autostart_orchestrator: false,
        },
        201
      )
    ).json()
  ).id as string
  const otherActor = `${another}:orchestrator`
  await start(otherActor, passive, another)
  await request(
    '/api/team/question',
    {
      project_id: another,
      from_agent_id: otherActor,
      token: runtime.store.peekAgentToken(otherActor),
      question_id: firstId,
    },
    409
  )
  await request(
    '/api/team/question',
    { ...identity(bob), project_id: another, question_id: firstId },
    401
  )
  for (let index = 0; index < 51; index += 1)
    await team(orchestrator, 'message', {
      dispatch_id: author,
      kind: 'question',
      text: `Paged question ${index}`,
    })
  const page = await json<{ questions: Message[]; next_before: string | null }>(
    cli(orchestrator, ['ask', '--list', '--dispatch', author])
  )
  assert.equal(page.questions.length, 50)
  assert.ok(page.next_before)
  assert.ok(
    page.questions.every(
      (item) => item.from_agent_id === orchestrator && item.dispatch_id === author
    )
  )
  const older = await json<{ questions: Message[]; next_before: string | null }>(
    cli(orchestrator, ['ask', '--list', '--dispatch', author, '--before', page.next_before])
  )
  assert.deepEqual(
    older.questions.map((item) => item.text),
    ['Paged question 0']
  )
  assert.equal(older.next_before, null)
  const cancelled = await json<QuestionResult>(
    cli(carol, ['ask', '--dispatch', unrelated, '--to', 'orchestrator', 'Will be cancelled'])
  )
  await team(orchestrator, 'cancel', { dispatch_id: unrelated, reason: 'Retire this question' })
  assert.equal(
    (await json<QuestionResult>(cli(carol, ['ask', '--resume', cancelled.question_id]))).status,
    'closed'
  )
  await team(
    orchestrator,
    'reply',
    { question_id: cancelled.question_id, text: 'Must not revive' },
    409
  )
  await team(bob, 'report', { dispatch_id: review, result: 'Unseen input rejected' }, 409)
  assert.equal(runtime.store.getWorker(workspaceId, bob).pendingTaskCount, 1)
  const messages = await json<{ required_seen_seq: number }>(
    cli(bob, ['messages', '--dispatch', review])
  )
  assert.ok(messages.required_seen_seq > 0)
  const report = await cli(bob, [
    'report',
    '--dispatch',
    review,
    '--seen',
    String(messages.required_seen_seq),
    'Verified with explicit seen',
  ]).result
  assert.equal(report.code, 0, report.stderr)
  assert.equal(runtime.store.getWorker(workspaceId, bob).pendingTaskCount, 0)
  assert.equal(
    runtime.store.listDispatches(workspaceId).find((item) => item.id === review)?.status,
    'reported'
  )
  const deletedQuestion = page.questions[0]
  assert.ok(deletedQuestion)
  runtime.store.deleteWorker(workspaceId, alice)
  assert.equal(
    (await json<QuestionResult>(cli(orchestrator, ['ask', '--resume', deletedQuestion.id]))).status,
    'closed'
  )

  // Configure real persisted binding state directly: exercise new HTTP entry
  // points under a changed thread without invoking Codex host notifications.
  await mkdir(join(root, 'external'))
  const external = (
    await (
      await request(
        '/api/workspaces',
        {
          name: 'Retired controller fixture',
          path: join(root, 'external'),
          controller_mode: 'codex_app',
        },
        201
      )
    ).json()
  ).id as string
  const externalActor = `${external}:orchestrator`
  const externalWorker = (
    await (
      await request(
        `/api/workspaces/${external}/workers`,
        {
          name: 'External worker',
          role: 'coder',
        },
        201
      )
    ).json()
  ).id as string
  await start(externalWorker, passive, external)
  const db = openRuntimeDatabase(root)
  try {
    const controllers = createControllerStore(db)
    const bind = (thread: string) => {
      controllers.request(external, thread)
      const requestId = controllers.get(external).request_id
      assert.ok(requestId)
      controllers.confirm(external, requestId)
    }
    bind('old-thread')
    const task = await runtime.store.dispatchTaskByWorkerName(
      external,
      'External worker',
      'Bound task',
      {
        fromAgentId: externalActor,
        hivePort: String(runtime.port),
      }
    )
    const question = runtime.store.sendDispatchMessage(external, externalActor, {
      dispatchId: task.id,
      kind: 'question',
      text: 'Old controller question',
    })
    const externalIdentity = {
      project_id: external,
      from_agent_id: externalWorker,
      token: runtime.store.peekAgentToken(externalWorker),
      question_id: question.id,
    }
    assert.equal(
      (await (await request('/api/team/question', externalIdentity, 200)).json()).status,
      'pending'
    )
    controllers.disconnect(external)
    bind('new-thread')
    assert.equal(
      (await (await request('/api/team/question', externalIdentity, 200)).json()).status,
      'closed'
    )
    const answerCount = () =>
      runtime?.store
        .listWorkspaceDispatchMessages(external)
        .filter((item) => item.replyTo === question.id).length
    assert.equal(answerCount(), 0)
    await request(
      '/api/team/reply',
      { ...externalIdentity, text: 'Cannot cross controller binding' },
      409
    )
    assert.equal(answerCount(), 0)
  } finally {
    db.close()
  }
  console.log(
    'PASS: short CLI reply routing; nonblocking ask; durable resume/list; bounded wait; sender/workspace/root authorization; cancellation/removal/controller closure; unchanged explicit seen barrier'
  )
} finally {
  await Promise.all(
    [...processes].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve())
          child.kill('SIGKILL')
        })
    )
  )
  try {
    await runtime?.close()
  } finally {
    if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousDataDir
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
