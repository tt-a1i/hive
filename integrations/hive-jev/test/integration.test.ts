import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { runBrowserTask } from '../src/browser.js'
import type { TranscriptMessage } from '../src/compaction.js'
import { compactMessages, reviewAction, routeTask } from '../src/core.js'
import { automaticApproval } from '../src/policy.js'

interface Question {
  type: 'choice' | 'score' | 'noul'
  criteria?: Record<string, unknown>
}

type FakeAnswer =
  | {
      type: 'choice'
      choice: string
      confidence: number
      probabilities: Record<string, number>
    }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number }

function fakeAnswer(question: Question): FakeAnswer {
  if (question.type === 'choice') {
    const choices = Object.keys(question.criteria ?? {})
    const choice = choices[0]
    if (!choice) throw new Error('Choice question needs criteria.')
    return {
      type: 'choice',
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(choices.map((choice, index) => [choice, index ? 0 : 1])),
    }
  }
  if (question.type === 'score')
    return { type: 'score', score: 1, confidence: 1, probabilities: { 1: 1 } }
  return { type: 'noul', noul: 0.1 }
}

async function withFakeJev(
  callback: (requests: Array<Record<string, unknown>>) => Promise<void>,
  answer: (question: Question) => FakeAnswer = fakeAnswer
) {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      questions: Record<string, Question>
      [key: string]: unknown
    }
    requests.push(payload)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [key, answer(question)])
        ),
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const before = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL }
  process.env.TYPESAFE_API_KEY = 'test-key'
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${address.port}`
  try {
    await callback(requests)
  } finally {
    if (before.key === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = before.key
    if (before.url === undefined) delete process.env.TYPESAFE_BASE_URL
    else process.env.TYPESAFE_BASE_URL = before.url
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

test('route recommends only an existing member and never dispatches', async () =>
  withFakeJev(async () => {
    const result = await routeTask({
      task: 'test',
      roster_source: 'hive_authoritative_snapshot',
      candidates: [{ id: 'tester', description: 'Existing tester' }],
    })
    assert.equal((result.answers.member as { choice: string }).choice, 'tester')
    assert.equal(result.dispatch_executed, false)
  }))

test('route rejects duplicate member IDs before asking Jev', async () => {
  await assert.rejects(
    () =>
      routeTask({
        task: 'test',
        roster_source: 'hive_authoritative_snapshot',
        candidates: [
          { id: 'tester', description: 'First' },
          { id: 'tester', description: 'Duplicate' },
        ],
      }),
    /unique/
  )
})

test('route rejects a roster that is not asserted as authoritative', async () => {
  await assert.rejects(
    () =>
      routeTask({
        task: 'test',
        roster_source: 'untrusted' as 'hive_authoritative_snapshot',
        candidates: [{ id: 'tester', description: 'Unverified tester' }],
      }),
    /authoritative Hive roster/
  )
})

test('compaction returns a copy, preserves source, and shows Jev the tool result', async () =>
  withFakeJev(async (requests) => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        text: '',
        tool_uses: [{ tool_use_id: 'one', tool: 'shell', input: {} }],
        tool_results: [],
      },
      {
        role: 'user',
        text: '',
        tool_uses: [],
        tool_results: [{ tool_use_id: 'one', text: 'large result' }],
      },
      { role: 'user', text: 'keep this text', tool_uses: [], tool_results: [] },
    ]
    const before = JSON.stringify(messages)
    const result = await compactMessages(messages, { preserve_recent_messages: 1 })
    assert.equal(result.source_history_mutated, false)
    assert.equal(JSON.stringify(messages), before)
    assert.equal(result.messages.at(-1)?.text, 'keep this text')
    const state = requests[0]?.state as {
      history: Array<{ tool_results: Array<{ text: string }> }>
    }
    assert.equal(state.history[1]?.tool_results[0]?.text, 'large result')
  }))

test('review rejects an out-of-range risk score instead of auto-approving', async () =>
  withFakeJev(
    async () => {
      await assert.rejects(
        () =>
          reviewAction({
            user_request: 'Inspect status',
            allow_auto_approval: true,
            auto_approve_tools: ['status'],
            action: { tool: 'status', arguments: {} },
          }),
        /invalid risk level score/
      )
    },
    (question) => (question.type === 'score' ? { type: 'score', score: -1 } : fakeAnswer(question))
  ))

test('review auto-approves only clear low-risk actions', async () =>
  withFakeJev(async () => {
    const result = await reviewAction({
      user_request: 'Inspect status',
      allow_auto_approval: true,
      auto_approve_tools: ['status'],
      action: { tool: 'status', arguments: {} },
    })
    assert.equal(result.auto_approved, true)
    assert.equal(result.action_executed, false)
    assert.equal(
      automaticApproval({
        securityDecision: 'caution',
        requiresUserConfirmation: false,
        riskLevel: 0,
      }).auto_approved,
      false
    )
    assert.equal(
      automaticApproval({
        securityDecision: 'clear',
        requiresUserConfirmation: false,
        riskLevel: 0,
        tool: 'status',
        allowedTools: ['status'],
      }).auto_approved,
      false
    )
  }))

test('browser execution requires opt-in and independent acceptance', async () => {
  await assert.rejects(
    () => runBrowserTask({ url: 'https://example.com', goal: 'Open', allow_execution: false }),
    /allow_execution/
  )
  await assert.rejects(
    () => runBrowserTask({ url: 'https://example.com', goal: 'Open', allow_execution: true }),
    /expected outcome/
  )
  await assert.rejects(
    () =>
      runBrowserTask({
        url: 'https://example.com',
        goal: 'Open',
        allow_execution: true,
        allowed_origins: ['https://other.example'],
        expect_title_contains: 'Fixture',
      }),
    /start URL origin must be allowlisted/
  )
})
