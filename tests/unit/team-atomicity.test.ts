import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('team atomicity', () => {
  test('dispatchTask does not bump pending count when message insert fails before PTY write', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const insertMessage = vi.fn(() => {
      throw new Error('insert message failed')
    })
    const createDispatch = vi.fn()
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const writeSendPrompt = vi.fn()
    const markTaskDispatched = vi.fn()
    const ops = createTeamOperations({
      agentRuntime: {
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch,
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        getWorkerByName: (workspaceId: string, workerName: string) => {
          const worker = store
            .getWorkspaceSnapshot(workspaceId)
            .agents.find((agent) => agent.name === workerName && agent.role !== 'orchestrator')
          if (!worker) {
            throw new Error(`Worker not found: ${workerName}`)
          }
          return worker
        },
        markTaskDispatched,
        markTaskReported: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/insert message failed/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'stopped',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0)).toEqual([])
    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(createDispatch).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(deleteDispatch).not.toHaveBeenCalled()
    expect(markTaskDispatched).not.toHaveBeenCalled()
  })

  test('dispatchTask deletes dispatch ledger record when worker start fails', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => undefined),
        writeReportPrompt: vi.fn(),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/No worker launch config available/)

    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'stopped',
      })
    )
  })

  test('dispatchTask revalidates worker after startup before writing stdin', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const markDispatchSubmitted = vi.fn()
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => ({ command: 'node' })),
        startAgent: vi.fn(async () => {
          store.deleteWorker(workspace.id, worker.id)
          return { status: 'running' }
        }),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted,
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/Agent not found|Worker not found/)

    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(markDispatchSubmitted).not.toHaveBeenCalled()
    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask with requireActiveRun throws and leaves pending count + messages untouched when orch run is absent', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    // Dispatch first so pendingTaskCount rises to 1 — gives reportTask something to decrement.
    store.dispatchTask(workspace.id, worker.id, 'Implement login')
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ status: 'queued', text: 'Implement login' })
    )
    const beforeMessages = store.listMessagesForRecovery(workspace.id, 0).length

    // Now request a report that REQUIRES an active orchestrator run. There is none,
    // so writeReportPrompt will throw. Nothing downstream (insertMessage, markTaskReported)
    // must run.
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: 'Done',
        requireActiveRun: true,
      })
    ).toThrow()

    // pending count stays at 1 (no decrement), messages list unchanged.
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0).length).toBe(beforeMessages)
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({
        status: 'queued',
        text: 'Implement login',
        reportText: null,
      })
    )
  })

  test('reportTask does not write orchestrator stdin when dispatch ledger update fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteMessage = vi.fn()
    const markTaskReported = vi.fn()
    const writeReportPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeReportPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(() => {
        throw new Error('dispatch ledger failed')
      }),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
    })

    expect(() =>
      ops.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        status: 'success',
        text: 'Done',
      })
    ).toThrow(/dispatch ledger failed/)

    expect(writeReportPrompt).not.toHaveBeenCalled()
    expect(markTaskReported).not.toHaveBeenCalled()
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask keeps the recorded report when orchestrator stdin forwarding fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteMessage = vi.fn()
    const markDispatchReportedByWorker = vi.fn(() => ({ ...dispatch, status: 'reported' }))
    const markTaskReported = vi.fn()
    const reportForwardError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeReportPrompt: vi.fn(() => {
          throw new Error('stdin write failed')
        }),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker,
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
    })

    const result = ops.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      status: 'success',
      text: 'Done',
    })

    expect(markDispatchReportedByWorker).toHaveBeenCalledWith({
      artifacts: [],
      reportText: 'Done',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    expect(markTaskReported).toHaveBeenCalledWith(workspace.id, worker.id)
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(reportForwardError).toHaveBeenCalledWith(
      '[hive] swallowed:teamReport.forward',
      expect.any(Error)
    )
    expect(result).toEqual({
      dispatch: { ...dispatch, status: 'reported' },
      forwardError: 'stdin write failed',
      forwarded: false,
    })
  })
})
