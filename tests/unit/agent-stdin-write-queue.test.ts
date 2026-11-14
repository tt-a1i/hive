import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentStdinDispatcher } from '../../src/server/agent-stdin-dispatcher.js'
import { PtyInactiveError } from '../../src/server/http-errors.js'
import { expandInboxReferences } from '../helpers/inbox.js'

type FakeRun = {
  agentId: string
  runId: string
  startedAt: number
  status: string
  output: string
}

const BRACKET_OPEN = '[200~'

const makeHarness = (command: string, input: { failWrite?: boolean } = {}) => {
  const runs: FakeRun[] = []
  const writes: Array<{ runId: string; text: string }> = []
  const agentManager = {
    getRun: (runId: string) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`no run ${runId}`)
      return run
    },
    writeInput: (runId: string, text: string) => {
      if (input.failWrite) throw new Error('pty write failed')
      writes.push({ runId, text })
      const run = runs.find((item) => item.runId === runId)
      if (!run) return
      if (text.includes(BRACKET_OPEN)) {
        run.output += '\n[Pasted Content 42 chars]\n'
      } else if (text === '\r') {
        run.output += '\nsubmitted\n❯ '
      }
    },
  }
  const registry = { list: () => runs.map((run) => ({ ...run })) }
  const dispatcher = createAgentStdinDispatcher({
    agentManager: agentManager as never,
    getLaunchConfig: () => ({ command, args: [] }),
    getWorkspaceId: (agentId: string) => agentId.split(':')[0] ?? '',
    registry: registry as never,
    syncRun: (run) => run,
  })
  return { runs, writes, dispatcher }
}

describe('per-agent stdin write queue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('uncontended write to an agent with no active run throws synchronously (send contract)', () => {
    const { dispatcher } = makeHarness(process.execPath) // no runs registered
    expect(() =>
      dispatcher.writeSendPrompt('ws', 'ws:w1', 'd1', 'Orchestrator', 'Coder role', 'do it')
    ).toThrow(PtyInactiveError)
  })

  test('two writes to the same agent do not interleave: the first submit precedes the second paste', async () => {
    vi.useFakeTimers()
    const { runs, writes, dispatcher } = makeHarness('codex')
    runs.push({
      agentId: 'ws:orchestrator',
      runId: 'r1',
      startedAt: 1,
      status: 'running',
      output: 'ready\n❯ ',
    })

    dispatcher.writeUserInputPrompt('ws', 'PAYLOAD_FIRST')
    dispatcher.writeUserInputPrompt('ws', 'PAYLOAD_SECOND')

    // Let both the paste→submit setTimeouts and the queue-draining microtasks run.
    await vi.advanceTimersByTimeAsync(2000)

    const texts = writes.map((w) => expandInboxReferences(w.text))
    const firstPaste = texts.findIndex(
      (t) => t.includes(BRACKET_OPEN) && t.includes('PAYLOAD_FIRST')
    )
    const secondPaste = texts.findIndex(
      (t) => t.includes(BRACKET_OPEN) && t.includes('PAYLOAD_SECOND')
    )
    expect(firstPaste).toBeGreaterThanOrEqual(0)
    expect(secondPaste).toBeGreaterThanOrEqual(0)
    // A submit Enter ('\r') must appear BETWEEN the two pastes — proving the
    // first write's full sequence finished before the second began. Without the
    // queue, the second paste lands immediately after the first (no '\r'
    // between), so this fails.
    const submitBetween = texts.slice(firstPaste + 1, secondPaste).some((t) => t === '\r')
    expect(submitBetween).toBe(true)
  })

  test('writes to different agents are not blocked by each other', async () => {
    vi.useFakeTimers()
    const { runs, writes, dispatcher } = makeHarness('codex')
    runs.push({
      agentId: 'ws:orchestrator',
      runId: 'r1',
      startedAt: 1,
      status: 'running',
      output: 'ready\n❯ ',
    })
    runs.push({
      agentId: 'ws:w2',
      runId: 'r2',
      startedAt: 1,
      status: 'running',
      output: 'ready\n❯ ',
    })

    dispatcher.writeUserInputPrompt('ws', 'ORCH_MSG')
    dispatcher.writeCancelPrompt('ws', 'ws:w2', 'd9', 'stop now')

    // Before any submit timer fires, both agents should already have pasted —
    // neither waits on the other's chain.
    await Promise.resolve()
    expect(writes.some((w) => w.runId === 'r1')).toBe(true)
    expect(writes.some((w) => w.runId === 'r2')).toBe(true)
  })
})
