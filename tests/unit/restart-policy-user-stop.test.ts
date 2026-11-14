import { describe, expect, test, vi } from 'vitest'
import { createRestartPolicy } from '../../src/server/restart-policy.js'
import type { AgentSummary } from '../../src/shared/types.js'

const AGENT_ID = 'ws-1:orchestrator'
const PREV_RUN = 'run-prev'
const CURRENT_RUN = 'run-current'

const run = (runId: string) =>
  ({
    runId,
    agentId: AGENT_ID,
    status: 'error',
    exitCode: 1,
    pid: 1,
    startedAt: 1,
    endedAt: 2,
  }) as never

const agentSummary: AgentSummary = {
  id: AGENT_ID,
  workspaceId: 'ws-1',
  name: 'Orchestrator',
  description: '',
  role: 'orchestrator',
  status: 'stopped',
  pendingTaskCount: 0,
}

const workspace = { id: 'ws-1', name: 'Alpha', path: '/tmp/alpha' } as never

const makePolicy = () => {
  const insertMessage = vi.fn(() => ({ sequence: 1 }) as never)
  const writeToRun = vi.fn(() => Promise.resolve())
  const policy = createRestartPolicy({
    deleteMessage: vi.fn(),
    getWorkspaceSnapshot: () => ({ agents: [agentSummary], summary: workspace }),
    insertMessage,
    listAgentRuns: () => [run(PREV_RUN), run(CURRENT_RUN)],
    listMessagesForRecovery: () => [],
    readTasks: () => '',
  })
  const inject = () =>
    policy.injectPostStartMessage({
      agentId: AGENT_ID,
      runId: CURRENT_RUN,
      startConfig: {} as never,
      workspace,
      writeToRun,
    })
  return { policy, inject, insertMessage, writeToRun }
}

describe('restart policy — crash vs deliberate stop', () => {
  test('injects the crash-recovery handover after a non-stop exit', () => {
    const { inject, insertMessage, writeToRun } = makePolicy()

    expect(inject()).toBe(true)
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(writeToRun).toHaveBeenCalledTimes(1)
  })

  test('skips the handover when the previous run was a deliberate user stop', () => {
    const { policy, inject, insertMessage, writeToRun } = makePolicy()

    policy.markUserStopped(PREV_RUN)

    expect(inject()).toBe(false)
    expect(insertMessage).not.toHaveBeenCalled()
    expect(writeToRun).not.toHaveBeenCalled()
  })

  test('consumes the stop marker so a later genuine crash still recovers', () => {
    const { policy, inject, insertMessage } = makePolicy()

    policy.markUserStopped(PREV_RUN)
    expect(inject()).toBe(false)
    expect(insertMessage).not.toHaveBeenCalled()

    // Marker consumed — the next restart for the same previous run injects.
    expect(inject()).toBe(true)
    expect(insertMessage).toHaveBeenCalledTimes(1)
  })

  test('skips handover on native session resume when there is no open protocol work (#41)', () => {
    const insertMessage = vi.fn(() => ({ sequence: 1 }) as never)
    const writeToRun = vi.fn(() => Promise.resolve())
    const policy = createRestartPolicy({
      deleteMessage: vi.fn(),
      getWorkspaceSnapshot: () => ({
        agents: [
          { ...agentSummary, description: 'CURRENT_ROLE_SCOPE' },
          {
            ...agentSummary,
            id: 'ws-1:new-member',
            name: 'New teammate',
            role: 'coder',
            status: 'working',
            pendingTaskCount: 1,
          },
        ],
        summary: workspace,
      }),
      insertMessage,
      listAgentRuns: () => [run(PREV_RUN), run(CURRENT_RUN)],
      listMessagesForRecovery: () => [
        { type: 'user_input', text: 'earlier message', createdAt: Date.now() } as never,
      ],
      listOpenDispatches: () => [],
      listActionableDispatchMessagesForRecovery: () => [],
      readTasks: () => '- [ ] task',
    })

    const injected = policy.injectPostStartMessage({
      agentId: AGENT_ID,
      runId: CURRENT_RUN,
      startConfig: { command: 'claude', args: ['--resume', 'sess-123'] } as never,
      workspace,
      writeToRun,
    })

    expect(injected).toBe(false)
    expect(insertMessage).not.toHaveBeenCalled()
    expect(writeToRun).not.toHaveBeenCalled()
  })

  test('refreshes current workspace context without repeating history on a busy native resume', () => {
    let writtenText = ''
    const insertMessage = vi.fn(() => ({ sequence: 1 }) as never)
    const writeToRun = vi.fn((_runId: string, text: string) => {
      writtenText = text
      return Promise.resolve()
    })
    const policy = createRestartPolicy({
      deleteMessage: vi.fn(),
      getWorkspaceSnapshot: () => ({
        agents: [
          { ...agentSummary, description: 'CURRENT_ROLE_SCOPE' },
          {
            ...agentSummary,
            id: 'ws-1:new-member',
            name: 'New teammate',
            role: 'coder',
            status: 'working',
            pendingTaskCount: 1,
          },
        ],
        summary: workspace,
      }),
      insertMessage,
      listAgentRuns: () => [run(PREV_RUN), run(CURRENT_RUN)],
      listMessagesForRecovery: () => [
        {
          type: 'user_input',
          text: 'SHOULD_NOT_REPEAT_CHAT_HISTORY',
          createdAt: Date.now(),
        } as never,
      ],
      listOpenDispatches: () => [
        {
          id: 'disp-open-1',
          workspaceId: 'ws-1',
          fromAgentId: AGENT_ID,
          toAgentId: 'worker-1',
          status: 'submitted',
          text: 'finish migration',
        } as never,
      ],
      listActionableDispatchMessagesForRecovery: () => [],
      readTasks: () => 'CURRENT_TASKS_CONTENT',
    })

    const injected = policy.injectPostStartMessage({
      agentId: AGENT_ID,
      runId: CURRENT_RUN,
      startConfig: { command: 'claude', args: ['--resume', 'sess-123'] } as never,
      workspace,
      writeToRun,
    })

    expect(injected).toBe(true)
    expect(writtenText).toContain('Your native session resumed.')
    expect(writtenText).toContain('disp-open-1')
    expect(writtenText).not.toContain('SHOULD_NOT_REPEAT_CHAT_HISTORY')
    expect(writtenText).toContain('CURRENT_TASKS_CONTENT')
    expect(writtenText).toContain('CURRENT_ROLE_SCOPE')
    expect(writtenText).toContain('New teammate (coder, working, pending_task_count: 1)')
    expect(writtenText).not.toContain('## Hive member dispatch rules')
  })
})
