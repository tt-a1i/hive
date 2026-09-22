import { describe, expect, test, vi } from 'vitest'
import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { PromptReadinessTimeoutError } from '../../src/server/http-errors.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTeamOperations, type TeamOperationsInput } from '../../src/server/team-operations.js'

const makeDispatch = (overrides: Partial<DispatchRecord>): DispatchRecord =>
  ({
    artifacts: [],
    createdAt: Date.now(),
    deliveredAt: null,
    fromAgentId: null,
    id: 'dispatch-1',
    label: null,
    phase: null,
    reportedAt: null,
    reportText: null,
    sequence: 1,
    status: 'queued',
    stepIndex: null,
    submittedAt: null,
    text: 'implement login',
    toAgentId: 'worker-1',
    workflowRunId: null,
    workspaceId: 'ws-1',
    ...overrides,
  }) as DispatchRecord

describe('replay failure recovery (review findings)', () => {
  test('a failed replay write re-parks the dispatch instead of cancelling it', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const parked = makeDispatch({
      fromAgentId: orchestrator.id,
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const reparkClaimedDispatch = vi.fn(() => true)
    const markDispatchCancelled = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt: vi.fn(() => {
          throw new Error('Run became inactive before input was submitted')
        }),
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(),
      markDispatchCancelled,
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch,
      listOpenWorkspaceDispatches: vi.fn(() => [parked]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: store as never,
    })

    ops.replayQueuedDispatches(workspace.id, worker.id)

    // One bad start must not destroy parked work: claim is reverted, the
    // dispatch is never cancelled, and the next start retries it.
    expect(reparkClaimedDispatch).toHaveBeenCalledWith(parked.id)
    expect(markDispatchCancelled).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('a prompt-readiness timeout during replay cancels and notifies instead of parking forever', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const parked = makeDispatch({
      fromAgentId: orchestrator.id,
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const reparkClaimedDispatch = vi.fn(() => true)
    const markDispatchCancelled = vi.fn(() => ({ ...parked, status: 'cancelled' as const }))
    const markTaskCancelled = vi.fn()
    const deliverSystemMessageToAgent = vi.fn(() => Promise.resolve())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      agentRuntime: {
        deliverSystemMessageToAgent,
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt: vi.fn(() => {
          throw new PromptReadinessTimeoutError('hermes', 'run-1')
        }),
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(),
      markDispatchCancelled,
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch,
      listOpenWorkspaceDispatches: vi.fn(() => [parked]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: { ...store, markTaskCancelled } as never,
    })

    ops.replayQueuedDispatches(workspace.id, worker.id)

    expect(reparkClaimedDispatch).not.toHaveBeenCalled()
    expect(markDispatchCancelled).toHaveBeenCalledWith({
      dispatchId: parked.id,
      reason: 'Timed out waiting for hermes prompt readiness: run-1',
      workspaceId: workspace.id,
    })
    expect(markTaskCancelled).toHaveBeenCalledWith(workspace.id, worker.id)
    expect(deliverSystemMessageToAgent).toHaveBeenCalledWith(
      workspace.id,
      orchestrator.id,
      expect.stringContaining('CANCELLED'),
      { requireActiveRun: true }
    )
    consoleError.mockRestore()
  })

  test('replay skips workflow-owned dispatches entirely', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const workflowOwned = makeDispatch({
      id: 'dispatch-wf',
      toAgentId: worker.id,
      workspaceId: workspace.id,
      workflowRunId: 'run-7',
      fromAgentId: `${workspace.id}:__workflow__`,
    })
    const claimQueuedDispatch = vi.fn(() => true)
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [workflowOwned]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: store as never,
    })

    ops.replayQueuedDispatches(workspace.id, worker.id)
    expect(claimQueuedDispatch).not.toHaveBeenCalled()
    expect(writeSendPrompt).not.toHaveBeenCalled()
  })

  test('startup replay skips dispatches created after the active run started', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const oldParked = makeDispatch({
      createdAt: 1_000,
      fromAgentId: orchestrator.id,
      id: 'dispatch-before-start',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const newDuringStartup = makeDispatch({
      createdAt: 2_000,
      fromAgentId: orchestrator.id,
      id: 'dispatch-after-start',
      sequence: 2,
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const dispatches = [oldParked, newDuringStartup]
    const claimQueuedDispatch = (id: string) => {
      const item = dispatches.find((candidate) => candidate.id === id)
      if (!item || item.status !== 'queued') return false
      item.status = 'submitted'
      return true
    }
    const received: Array<{ id: string; text: string; seen: number }> = []
    const writeSendPrompt: TeamOperationsInput['agentRuntime']['writeSendPrompt'] = (
      _workspaceId,
      _workerId,
      id,
      _sender,
      _description,
      text,
      seen,
      options
    ) => {
      const allowed = options?.beforeWrite?.() ?? true
      if (allowed) received.push({ id, text, seen: seen ?? 0 })
      return { payloadBytes: Buffer.byteLength(text), write: Promise.resolve(allowed) }
    }
    const inboundNotes = new Map<string, number>([[oldParked.id, 4]])

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: (workspaceId, id) =>
        dispatches.find((item) => item.workspaceId === workspaceId && item.id === id),
      insertMessage: vi.fn(),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [oldParked, newDuringStartup]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: store as never,
      requiredSeenSeq: (dispatchId) => inboundNotes.get(dispatchId) ?? 0,
    })

    ops.replayQueuedDispatches(workspace.id, worker.id, { createdBeforeMs: 1_500 })

    expect(oldParked.status).toBe('submitted')
    expect(newDuringStartup.status).toBe('queued')
    expect(received).toEqual([{ id: oldParked.id, text: 'implement login', seen: 4 }])
  })

  test('late replay write failure does not mutate dispatch state after runtime close begins', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const parked = makeDispatch({
      fromAgentId: orchestrator.id,
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    let closing = false
    let rejectWrite!: (error: Error) => void
    const markDispatchCancelled = vi.fn()
    const reparkClaimedDispatch = vi.fn(() => true)

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt: vi.fn(() => ({
          payloadBytes: 0,
          write: new Promise<void>((_resolve, reject) => {
            rejectWrite = reject
          }),
        })),
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(),
      markDispatchCancelled,
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch,
      listOpenWorkspaceDispatches: vi.fn(() => [parked]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      isRuntimeClosing: () => closing,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: store as never,
    })

    ops.replayQueuedDispatches(workspace.id, worker.id)
    closing = true
    rejectWrite(new Error('runtime is closing'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reparkClaimedDispatch).not.toHaveBeenCalled()
    expect(markDispatchCancelled).not.toHaveBeenCalled()
  })

  test('ephemeral report auto-dismiss is skipped after runtime close begins', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      ephemeral: true,
      name: 'Alice',
      role: 'coder',
      spawnedBy: 'orchestrator',
    })
    const dispatch = makeDispatch({
      fromAgentId: `${workspace.id}:orchestrator`,
      status: 'submitted',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    let closing = false
    const dismissEphemeralWorker = vi.fn()
    const markTaskReported = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeReportPrompt: vi.fn(),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(() => ({ ...dispatch, status: 'reported' as const })),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      dismissEphemeralWorker,
      isRuntimeClosing: () => closing,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: {
        getWorker: vi.fn(() => ({ ...worker, pendingTaskCount: 0 })),
        listWorkers: vi.fn(() => [{ ...worker, pendingTaskCount: 0 }]),
        markTaskReported,
      } as never,
    })

    ops.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      requireActiveRun: false,
      status: 'success',
      text: 'Done',
    })
    closing = true
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dismissEphemeralWorker).not.toHaveBeenCalled()
    expect(markTaskReported).toHaveBeenCalledWith(workspace.id, worker.id)
  })

  test('cancelTask resolves the workflow awaiter when a workflow-owned dispatch is cancelled from outside the runner', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const workflowOwned = makeDispatch({
      id: 'dispatch-wf',
      toAgentId: worker.id,
      workspaceId: workspace.id,
      workflowRunId: 'run-7',
      status: 'submitted',
    })
    const notifyCancel = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeCancelPrompt: vi.fn(() => Promise.resolve()),
        writeSendPrompt: vi.fn(),
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => workflowOwned),
      insertMessage: vi.fn(),
      markDispatchCancelled: vi.fn(() => ({ ...workflowOwned, status: 'cancelled' as const })),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
      } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel } as never,
      workspaceStore: { ...store, markTaskCancelled: vi.fn() } as never,
    })

    await ops.cancelTask(workspace.id, workflowOwned.id, {
      fromAgentId: orchestrator.id,
      reason: 'stale',
    })
    // Without this the runner's awaitReport hangs until its step timeout.
    expect(notifyCancel).toHaveBeenCalledWith(workflowOwned.id, 'stale')
  })

  test('issuer notification falls back to the report outbox when the issuer has no active run', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const parked = makeDispatch({
      fromAgentId: orchestrator.id,
      toAgentId: worker.id,
      workspaceId: workspace.id,
      status: 'submitted',
    })
    const enqueue = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt: vi.fn(() => ({
          payloadBytes: 0,
          write: Promise.reject(new Error('pty died')),
        })),
        // Issuer down: the awaitable delivery rejects.
        deliverSystemMessageToAgent: vi.fn(() => Promise.reject(new Error('no active run'))),
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => parked),
      insertMessage: vi.fn(),
      markDispatchCancelled: vi.fn(() => ({ ...parked, status: 'cancelled' as const })),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [parked]),
      markDispatchReportedByWorker: vi.fn(),
      reportOutbox: { enqueue, listPending: vi.fn(() => []), markDelivered: vi.fn() } as never,
      workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
      workspaceStore: store as never,
    })

    // Dismissing a worker with a parked dispatch routes through the same
    // durable notifier — exercise it directly.
    ops.notifyIssuersOfDroppedDispatches(workspace.id, worker.id, 'the worker was dismissed')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        targetAgentId: orchestrator.id,
        dispatchId: parked.id,
        payload: expect.stringContaining('DROPPED'),
      })
    )
    consoleError.mockRestore()
  })
})
