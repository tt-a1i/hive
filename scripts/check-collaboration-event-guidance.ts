/** Exercises generated reply commands through real CLI / HTTP / SQLite / PTYs; no model. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { runHiveCommand } from '../src/cli/hive.js'

const root = await mkdtemp(join(tmpdir(), 'hive-event-guidance-'))
const previousDataDir = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = root
let runtime: Awaited<ReturnType<typeof runHiveCommand>> | undefined
let cookie = ''
let workspaceId = ''
const runs = new Map<string, string>()
const request = async (path: string, body?: object, status = body ? 202 : 200) => {
  const response = await fetch(`http://127.0.0.1:${runtime?.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, status, await response.clone().text())
  return response
}
const team = (actor: string, command: string, body: object, status = 202) =>
  request(
    `/api/team/${command}`,
    {
      project_id: workspaceId,
      from_agent_id: actor,
      token: runtime?.store.peekAgentToken(actor),
      ...body,
    },
    status
  )
const answerQuestion = async (messageId: string, recipientId: string) => {
  let command: string | undefined
  const deadline = Date.now() + 10000
  while (!command && Date.now() < deadline) {
    const { output } = await (await request(`/api/runtime/runs/${runs.get(recipientId)}`)).json()
    const tail = String(output).split(`message="${messageId}"`)[1]
    const envelope = tail?.includes('</hive-message>')
      ? tail.split('</hive-message>')[0]
      : undefined
    if (envelope) {
      command = envelope.match(/(?:^|\n)Reply: (team reply [^\r\n]+)/u)?.[1]
      assert.ok(command, `Delivered question lacks its executable reply command: ${envelope}`)
    } else await setTimeout(20)
  }
  assert.ok(command, 'Question did not reach its real PTY')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/team', ...command.split(' ').slice(1)],
      {
        env: {
          ...process.env,
          HIVE_PORT: String(runtime?.port),
          HIVE_PROJECT_ID: workspaceId,
          HIVE_AGENT_ID: recipientId,
          HIVE_AGENT_TOKEN: runtime?.store.peekAgentToken(recipientId),
        },
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 10000,
      }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `CLI exit ${code}`))
    )
    child.stdin.end(`Verified answer for ${messageId}`)
  })
  const answers = runtime?.store
    .listWorkspaceDispatchMessages(workspaceId)
    .filter((item) => item.replyTo === messageId)
  assert.equal(answers?.length, 1)
  assert.equal(answers?.[0]?.fromAgentId, recipientId)
  return answers?.[0]
}
try {
  const passive = join(root, 'passive.cjs')
  await writeFile(
    passive,
    "process.stdin.setRawMode(true); process.stdout.write('SELF_CHECK_READY\\n'); process.stdin.on('data', data => process.stdout.write(data))\n"
  )
  runtime = await runHiveCommand(['--port', '0', '--no-open'])
  cookie = (await request('/api/ui/session')).headers.get('set-cookie') ?? ''
  workspaceId = (
    await (
      await request(
        '/api/workspaces',
        {
          name: 'Event guidance self-check',
          path: root,
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
  ).id as string
  const bob = (
    await (
      await request(
        `/api/workspaces/${workspaceId}/workers`,
        { name: 'Bob', role: 'reviewer' },
        201
      )
    ).json()
  ).id as string
  for (const actor of [orchestrator, alice, bob]) {
    await request(
      `/api/workspaces/${workspaceId}/agents/${actor}/config`,
      { command: process.execPath, args: [passive] },
      204
    )
    const run = await (
      await request(
        `/api/workspaces/${workspaceId}/agents/${actor}/start`,
        { hive_port: String(runtime.port) },
        201
      )
    ).json()
    runs.set(actor, run.run_id)
    const deadline = Date.now() + 10000
    let ready = false
    while (!ready && Date.now() < deadline) {
      const { output } = await (await request(`/api/runtime/runs/${run.run_id}`)).json()
      ready = String(output).includes('SELF_CHECK_READY')
      if (!ready) await setTimeout(20)
    }
    assert.ok(ready, 'Passive PTY did not enter raw mode')
  }
  const author = (
    await (await team(orchestrator, 'send', { to: 'Alice', text: 'Produce the evidence' })).json()
  ).dispatch_id as string
  const review = (
    await (
      await team(orchestrator, 'send', {
        to: 'Bob',
        text: 'Review the evidence',
        related_to_dispatch_id: author,
      })
    ).json()
  ).dispatch_id as string
  await team(alice, 'report', { dispatch_id: author, result: 'Original outcome' })
  const ask = async (from: string, dispatch: string, extra: object = {}) => {
    await team(from, 'message', {
      dispatch_id: dispatch,
      kind: 'question',
      text: 'Explain the evidence',
      ...extra,
    })
    const question = runtime?.store.listWorkspaceDispatchMessages(workspaceId).at(-1)
    assert.ok(question)
    return question.id
  }
  const historical = await ask(bob, author, { source_dispatch_id: review })
  const peerAnswer = await answerQuestion(historical, alice)
  assert.ok(peerAnswer)
  assert.equal(peerAnswer?.dispatchId, review)
  assert.equal(peerAnswer?.sourceDispatchId, author)
  assert.equal(peerAnswer?.recipientAgentId, bob)
  const controllerQuestion = await ask(orchestrator, author)
  const historicalAnswer = await answerQuestion(controllerQuestion, alice)
  assert.equal(historicalAnswer?.dispatchId, author)
  assert.equal(historicalAnswer?.recipientAgentId, orchestrator)
  const decision = await ask(bob, review, { recipient: 'orchestrator' })
  const decisionAnswer = await answerQuestion(decision, orchestrator)
  assert.ok(decisionAnswer)
  assert.equal(decisionAnswer?.dispatchId, review)
  assert.equal(decisionAnswer?.sourceDispatchId, null)
  assert.equal(decisionAnswer?.recipientAgentId, bob)
  assert.deepEqual(
    runtime.store.listOpenDispatches(workspaceId).map((item) => item.id),
    [review]
  )
  assert.equal(runtime.store.getWorker(workspaceId, alice).pendingTaskCount, 0)
  assert.equal(runtime.store.getWorker(workspaceId, bob).pendingTaskCount, 1)

  await team(bob, 'message', {
    dispatch_id: review,
    recipient: 'orchestrator',
    kind: 'progress',
    text: 'Verification is still running',
  })
  const progress = runtime.store.listWorkspaceDispatchMessages(workspaceId).at(-1)
  assert.ok(progress)
  const inbox = await (
    await team(bob, 'messages', { dispatch_id: review, after_seq: peerAnswer.sequence }, 200)
  ).json()
  assert.deepEqual(
    inbox.messages.map((item: { id: string }) => item.id),
    [decision, decisionAnswer.id, progress.id]
  )
  assert.equal(inbox.required_seen_seq, decisionAnswer?.sequence)
  assert.ok(progress.sequence > inbox.required_seen_seq)
  await team(
    bob,
    'report',
    { dispatch_id: review, result: 'Wrong sequence', seen_seq: progress.sequence },
    409
  )
  assert.equal(runtime.store.listOpenDispatches(workspaceId)[0]?.id, review)
  await team(bob, 'report', {
    dispatch_id: review,
    result: 'Verified review',
    seen_seq: inbox.required_seen_seq,
  })
  assert.equal(runtime.store.listOpenDispatches(workspaceId).length, 0)
  console.log(
    'PASS: live reply routes, historical responsibility, incremental inbox and explicit report watermark'
  )
} finally {
  try {
    await runtime?.close()
  } finally {
    if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousDataDir
    await rm(root, { recursive: true, force: true })
  }
}
