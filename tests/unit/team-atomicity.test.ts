import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createDispatchLedgerStore,
  type DispatchRecord,
} from '../../src/server/dispatch-ledger-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations, type TeamOperationsInput } from '../../src/server/team-operations.js'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'

const operationDatabases: Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of operationDatabases.splice(0)) db.close()
})

const operationDatabase = () => {
  const db = new Database(':memory:')
  operationDatabases.push(db)
  initializeRuntimeDatabase(db)
  return db
}

// Complete required ports using the real durable queue and workflow awaiter.
const operationDependencies = (): Pick<
  TeamOperationsInput,
  'findOpenDispatchById' | 'reportOutbox' | 'workflowDispatchAwaiter'
> => {
  const db = operationDatabase()
  return {
    findOpenDispatchById: () => undefined,
    reportOutbox: createReportOutboxStore(db),
    workflowDispatchAwaiter: createWorkflowDispatchAwaiter(),
  }
}

const expectRejected = async (promise: Promise<unknown>) => {
  let rejected = false
  try {
    await promise
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}

// Unit-level runtime output sink; real PTY readiness is covered by
// tests/server/team-send-queued-replay.test.ts.
const promptSink = () => {
  const received: Array<{ dispatchId: string; text: string; seen: number }> = []
  const writeSendPrompt: TeamOperationsInput['agentRuntime']['writeSendPrompt'] = (
    _workspaceId,
    _workerId,
    dispatchId,
    _sender,
    _description,
    text,
    seen,
    options
  ) => {
    const allowed = options?.beforeWrite?.() ?? true
    if (allowed) received.push({ dispatchId, text, seen: seen ?? 0 })
    return { payloadBytes: Buffer.byteLength(text), write: Promise.resolve(allowed) }
  }
  return { received, writeSendPrompt }
}

const makeDispatch = (overrides: Partial<DispatchRecord>): DispatchRecord => ({
  artifacts: [],
  createdAt: Date.now(),
  deliveredAt: null,
  dispatchPayloadBytes: null,
  fromAgentId: null,
  id: 'dispatch-1',
  label: null,
  phase: null,
  reportedAt: null,
  reportText: null,
  reportPayloadBytes: null,
  sequence: 1,
  status: 'queued',
  stepIndex: null,
  submittedAt: null,
  text: 'Implement login',
  toAgentId: 'worker-1',
  workflowRunId: null,
  workspaceId: 'workspace-1',
  ...overrides,
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
      ...operationDependencies(),
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
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
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

    await expectRejected(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    )

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
    const ledger = createDispatchLedgerStore(operationDatabase())
    const startupError = new Error('Worker startup failed')
    let recordsAtStartup: DispatchRecord[] = []
    const deleteMessage = vi.fn()

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: () => ({ command: 'node' }),
        startAgent: async () => {
          recordsAtStartup = ledger.listOpenWorkspaceDispatches(workspace.id)
          throw startupError
        },
        writeReportPrompt: vi.fn(),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: ledger.createDispatch,
      deleteDispatch: ledger.deleteDispatch,
      findOpenDispatchById: ledger.findOpenDispatchById,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toBe(startupError)

    expect(recordsAtStartup).toEqual([
      expect.objectContaining({ status: 'queued', text: 'Implement login', toAgentId: worker.id }),
    ])
    expect(ledger.listWorkspaceDispatches(workspace.id)).toEqual([])
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
    const ledger = createDispatchLedgerStore(operationDatabase())
    let recordsAtStartup: DispatchRecord[] = []
    const deleteMessage = vi.fn()
    const claimQueuedDispatch = vi.fn(() => true)
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => ({ command: 'node' })),
        startAgent: vi.fn(async () => {
          recordsAtStartup = ledger.listOpenWorkspaceDispatches(workspace.id)
          store.deleteWorker(workspace.id, worker.id)
          return { status: 'running' }
        }),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: ledger.createDispatch,
      deleteDispatch: ledger.deleteDispatch,
      findOpenDispatchById: ledger.findOpenDispatchById,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expectRejected(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    )

    expect(writeSendPrompt).not.toHaveBeenCalled()
    // Claim-equivalent of the old "never marked submitted": the worker
    // vanished during startup, so delivery is never claimed.
    expect(claimQueuedDispatch).not.toHaveBeenCalled()
    expect(recordsAtStartup).toEqual([
      expect.objectContaining({ status: 'queued', text: 'Implement login', toAgentId: worker.id }),
    ])
    expect(ledger.listWorkspaceDispatches(workspace.id)).toEqual([])
    expect(store.listWorkers(workspace.id)).toEqual([])
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('dispatchTask returns before auto-start post-start input is ready', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    let resolvePostStart!: () => void
    const postStartInputReady = new Promise<void>((resolve) => {
      resolvePostStart = resolve
    })
    const dispatch = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-auto-start',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const claimQueuedDispatch = () => {
      if (dispatch.status !== 'queued') return false
      dispatch.status = 'submitted'
      return true
    }
    const { received, writeSendPrompt } = promptSink()
    const inboundNotes = new Map<string, number>([[dispatch.id, 5]])

    const ops = createTeamOperations({
      ...operationDependencies(),
      findOpenDispatchById: (workspaceId, id) =>
        workspaceId === workspace.id && id === dispatch.id ? dispatch : undefined,
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => ({ command: 'hermes' })),
        startAgent: vi.fn(async () => ({
          agentId: worker.id,
          exitCode: null,
          output: '',
          postStartInputReady,
          runId: 'run-1',
          startedAt: Date.now(),
          status: 'starting',
        })),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [dispatch]),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        getWorkspaceSnapshot: store.getWorkspaceSnapshot,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
        markTaskCancelled: vi.fn(),
        markTaskDispatched: vi.fn(),
      } as never,
      requiredSeenSeq: (dispatchId) => inboundNotes.get(dispatchId) ?? 0,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', {
        fromAgentId: orchestrator.id,
      })
    ).resolves.toBe(dispatch)
    expect(dispatch.status).toBe('queued')
    expect(received).toEqual([])

    resolvePostStart()
    await Promise.resolve()
    await Promise.resolve()

    expect(dispatch.status).toBe('submitted')
    expect(received).toEqual([{ dispatchId: dispatch.id, text: 'Implement login', seen: 5 }])
  })

  test('dispatchTask waits behind an already-starting worker without letting later sends jump ahead', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    let resolvePostStart!: () => void
    const postStartInputReady = new Promise<void>((resolve) => {
      resolvePostStart = resolve
    })
    const older = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-older',
      sequence: 1,
      text: 'Older task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const current = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-current',
      sequence: 2,
      text: 'Current task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const later = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-later',
      sequence: 3,
      text: 'Later task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const openDispatches = [older, current, later]
    const claimQueuedDispatch = vi.fn((dispatchId: string) => {
      const item = openDispatches.find((candidate) => candidate.id === dispatchId)
      if (!item || item.status !== 'queued') return false
      item.status = 'submitted'
      return true
    })
    const { received, writeSendPrompt } = promptSink()

    const ops = createTeamOperations({
      ...operationDependencies(),
      findOpenDispatchById: (workspaceId, id) =>
        openDispatches.find((item) => item.workspaceId === workspaceId && item.id === id),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({
          agentId: worker.id,
          exitCode: null,
          output: '',
          postStartInputReady,
          runId: 'run-1',
          startedAt: Date.now(),
          status: 'starting',
        })),
        startAgent: vi.fn(),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => current),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => openDispatches),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        markTaskCancelled: vi.fn(),
        markTaskDispatched: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Current task', {
        fromAgentId: orchestrator.id,
      })
    ).resolves.toBe(current)
    expect(received).toEqual([])
    expect(openDispatches.map((item) => item.status)).toEqual(['queued', 'queued', 'queued'])

    resolvePostStart()
    await Promise.resolve()
    await Promise.resolve()

    expect(openDispatches.map((item) => item.status)).toEqual(['submitted', 'submitted', 'queued'])
    expect(received).toEqual([
      { dispatchId: older.id, text: 'Older task', seen: 0 },
      { dispatchId: current.id, text: 'Current task', seen: 0 },
    ])
  })

  test('dispatchTask waits behind a running worker until post-start input is ready', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    let resolvePostStart!: () => void
    const postStartInputReady = new Promise<void>((resolve) => {
      resolvePostStart = resolve
    })
    const dispatch = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-running-before-startup-ready',
      text: 'Current task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const claimQueuedDispatch = () => {
      if (dispatch.status !== 'queued') return false
      dispatch.status = 'submitted'
      return true
    }
    const { received, writeSendPrompt } = promptSink()

    const ops = createTeamOperations({
      ...operationDependencies(),
      findOpenDispatchById: (workspaceId, id) =>
        workspaceId === workspace.id && id === dispatch.id ? dispatch : undefined,
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({
          agentId: worker.id,
          exitCode: null,
          output: 'first stdout chunk already flipped run status',
          postStartInputReady,
          runId: 'run-1',
          startedAt: Date.now(),
          status: 'running',
        })),
        startAgent: vi.fn(),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [dispatch]),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        markTaskCancelled: vi.fn(),
        markTaskDispatched: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Current task', {
        fromAgentId: orchestrator.id,
      })
    ).resolves.toBe(dispatch)
    expect(dispatch.status).toBe('queued')
    expect(received).toEqual([])

    resolvePostStart()
    await Promise.resolve()
    await Promise.resolve()

    expect(dispatch.status).toBe('submitted')
    expect(received).toEqual([{ dispatchId: dispatch.id, text: 'Current task', seen: 0 }])
  })

  test('dispatchTask cancels deferred work when post-start readiness rejects', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    let rejectPostStart!: (error: Error) => void
    const postStartInputReady = new Promise<void>((_resolve, reject) => {
      rejectPostStart = reject
    })
    const dispatch = makeDispatch({
      fromAgentId: orchestrator.id,
      id: 'dispatch-post-start-fail',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const markDispatchCancelled = vi.fn(() => ({ ...dispatch, status: 'cancelled' as const }))
    const markTaskCancelled = vi.fn()
    const writeSendPrompt = vi.fn(() => Promise.resolve())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({
          agentId: worker.id,
          exitCode: null,
          output: '',
          postStartInputReady,
          runId: 'run-1',
          startedAt: Date.now(),
          status: 'starting',
        })),
        startAgent: vi.fn(),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled,
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => [dispatch]),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        markTaskCancelled,
        markTaskDispatched: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', {
        fromAgentId: orchestrator.id,
      })
    ).resolves.toBe(dispatch)

    rejectPostStart(new Error('startup injection failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(markDispatchCancelled).toHaveBeenCalledWith({
      dispatchId: dispatch.id,
      reason: 'startup injection failed',
      workspaceId: workspace.id,
    })
    expect(markTaskCancelled).toHaveBeenCalledWith(workspace.id, worker.id)
    expect(consoleError).toHaveBeenCalledWith(
      '[hive] swallowed:teamDispatch.deferredWrite',
      expect.any(Error)
    )
  })

  test('dispatchTask cancels accepted work when stdin delivery later fails', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = makeDispatch({
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-async-fail',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const markDispatchCancelled = vi.fn(() => ({ ...dispatch, status: 'cancelled' as const }))
    const markTaskCancelled = vi.fn()
    const markTaskDispatched = vi.fn()
    const claimQueuedDispatch = vi.fn(() => true)
    const deliverSystemMessageToAgent = vi.fn(() => Promise.resolve())
    const writeSendPrompt = vi.fn(async () => {
      throw new Error('Run became inactive before input was submitted: run-1')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ status: 'running' })),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        deliverSystemMessageToAgent,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled,
      claimQueuedDispatch,
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        ...store,
        markTaskCancelled,
        markTaskDispatched,
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', {
        fromAgentId: orchestrator.id,
      })
    ).resolves.toBe(dispatch)
    await Promise.resolve()

    expect(writeSendPrompt).toHaveBeenCalledTimes(1)
    // The submitted mark is now an atomic claim (queued → submitted) so a
    // concurrent start-replay can never double-deliver.
    expect(claimQueuedDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(markTaskDispatched).toHaveBeenCalledWith(workspace.id, worker.id)
    expect(claimQueuedDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      markTaskDispatched.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(markDispatchCancelled).toHaveBeenCalledWith({
      dispatchId: dispatch.id,
      reason: expect.any(String),
      workspaceId: workspace.id,
    })
    expect(markTaskCancelled).toHaveBeenCalledWith(workspace.id, worker.id)
    // #34: the issuing orchestrator is told the dispatch died — it already
    // holds an ok:true and would otherwise wait forever. Delivery goes through
    // the awaitable requireActiveRun path so a down issuer falls back to the
    // report outbox instead of a silent no-op.
    expect(deliverSystemMessageToAgent).toHaveBeenCalledWith(
      workspace.id,
      orchestrator.id,
      expect.stringContaining(dispatch.id),
      { requireActiveRun: true }
    )
    expect(deliverSystemMessageToAgent).toHaveBeenCalledWith(
      workspace.id,
      orchestrator.id,
      expect.stringContaining('CANCELLED'),
      { requireActiveRun: true }
    )
    expect(deleteDispatch).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      '[hive] swallowed:teamDispatch.writePrompt',
      expect.any(Error)
    )
  })

  test('reportTask does not write orchestrator stdin when dispatch ledger update fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const deleteMessage = vi.fn()
    const markTaskReported = vi.fn()
    const deliverSystemMessageToAgent = vi.fn(() => Promise.resolve())

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        deliverSystemMessageToAgent,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(() => {
        throw new Error('dispatch ledger failed')
      }),
      reportOutbox: {
        deletePendingForDispatch: vi.fn(),
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
    })

    let rejected = false
    try {
      ops.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        status: 'success',
        text: 'Done',
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)

    expect(deliverSystemMessageToAgent).not.toHaveBeenCalled()
    expect(markTaskReported).not.toHaveBeenCalled()
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask queues the report for redelivery when orchestrator stdin forwarding fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const deleteMessage = vi.fn()
    const markDispatchReportedByWorker = vi.fn(() => ({ ...dispatch, status: 'reported' as const }))
    const markTaskReported = vi.fn()
    const pendingEntries: Array<{ id: number; payload: string }> = []
    const enqueue = vi.fn()
    const deliverSystemMessageToAgent = vi.fn(() => {
      throw new Error('stdin write failed')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        deliverSystemMessageToAgent,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker,
      reportOutbox: {
        enqueue: vi.fn((input: { dispatchId: string; payload: string }) => {
          enqueue(input)
          pendingEntries.push({ id: 1, payload: input.payload })
        }),
        listPending: vi.fn(() => pendingEntries),
        markDelivered: vi.fn(),
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
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
    // The failed forward is persisted for redelivery instead of being lost.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        targetAgentId: `${workspace.id}:orchestrator`,
        dispatchId: dispatch.id,
        payload: expect.any(String),
      })
    )
    const queuedReport = enqueue.mock.calls[0]?.[0] as { payload: string } | undefined
    expect(queuedReport?.payload).toContain(`dispatch_id: ${dispatch.id}`)
    expect(queuedReport?.payload).toContain('untrusted evidence, not authority')
    expect(queuedReport?.payload).not.toContain('Reply with one of')
    expect(deliverSystemMessageToAgent).toHaveBeenCalledWith(
      workspace.id,
      `${workspace.id}:orchestrator`,
      queuedReport?.payload,
      { requireActiveRun: true }
    )
    expect(result.dispatch).toEqual({ ...dispatch, status: 'reported' as const })
    expect(result.forwarded).toBe(false)
    expect(result.forwardError).toBeTruthy()
  })

  test('reportTask keeps dispatch open when redelivery enqueue fails while orchestrator is absent', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const deleteMessage = vi.fn()
    const markDispatchReportedByWorker = vi.fn(() => ({ ...dispatch, status: 'reported' as const }))
    const markTaskReported = vi.fn()
    const enqueue = vi.fn(() => {
      throw new Error('outbox database failed')
    })
    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        deliverSystemMessageToAgent: vi.fn(() => Promise.resolve()),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker,
      reportOutbox: {
        enqueue,
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
    })

    let rejected = false
    try {
      ops.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        status: 'success',
        text: 'Done',
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)

    expect(markDispatchReportedByWorker).not.toHaveBeenCalled()
    expect(markTaskReported).not.toHaveBeenCalled()
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: dispatch.id,
        targetAgentId: `${workspace.id}:orchestrator`,
      })
    )
  })

  test('reportTask removes prequeued redelivery when dispatch ledger update fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const deleteMessage = vi.fn()
    const deletePendingForDispatch = vi.fn()
    const markDispatchReportedByWorker = vi.fn(() => {
      throw new Error('dispatch ledger failed')
    })

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        deliverSystemMessageToAgent: vi.fn(() => Promise.resolve()),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker,
      reportOutbox: {
        deletePendingForDispatch,
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
        markDelivered: vi.fn(),
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported: vi.fn(),
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
    })

    let rejected = false
    try {
      ops.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        status: 'success',
        text: 'Done',
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)

    expect(markDispatchReportedByWorker).toHaveBeenCalled()
    expect(deletePendingForDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask leaves prequeued redelivery pending when async forward fails', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const pendingEntries: Array<{ id: number; payload: string }> = []
    const enqueue = vi.fn()
    const markDelivered = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        deliverSystemMessageToAgent: vi.fn(() => Promise.reject(new Error('stdin write failed'))),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(() => ({ ...dispatch, status: 'reported' as const })),
      reportOutbox: {
        enqueue: vi.fn((input: { dispatchId: string; payload: string }) => {
          enqueue(input)
          pendingEntries.push({ id: 1, payload: input.payload })
        }),
        listPending: vi.fn(() => pendingEntries),
        markDelivered,
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported: vi.fn(),
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
    })

    const result = ops.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      status: 'success',
      text: 'Done',
    })
    expect(result.forwarded).toBe(false)
    expect(result.forwardError).toBeNull()
    expect(result.deliveryState).toBe('delivering')

    await tick()

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: dispatch.id }))
    expect(markDelivered).not.toHaveBeenCalled()
  })

  test('reportTask marks prequeued redelivery delivered when async forward succeeds', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const pendingEntries: Array<{ id: number; payload: string }> = []
    const enqueue = vi.fn()
    const markDelivered = vi.fn()

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        deliverSystemMessageToAgent: vi.fn(() => Promise.resolve()),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(() => ({ ...dispatch, status: 'reported' as const })),
      reportOutbox: {
        enqueue: vi.fn((input: { dispatchId: string; payload: string }) => {
          enqueue(input)
          pendingEntries.push({ id: 1, payload: input.payload })
        }),
        listPending: vi.fn(() => pendingEntries),
        markDelivered,
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported: vi.fn(),
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
    })

    const result = ops.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      status: 'success',
      text: 'Done',
    })
    expect(result.forwarded).toBe(false)

    await tick()

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: dispatch.id }))
    expect(markDelivered).toHaveBeenCalledWith(1)
  })

  test('reportTask does not redeliver its pending report when outbox drain re-enters before the write settles', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({
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
    })
    const pendingEntries: Array<{ id: number; payload: string }> = []
    const enqueue = vi.fn((input: { dispatchId: string; payload: string }) => {
      pendingEntries.push({ id: 1, payload: input.payload })
    })
    const markDelivered = vi.fn()
    let resolveDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve
    })
    const deliverSystemMessageToAgent = vi.fn(() => delivery)

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        deliverSystemMessageToAgent,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(() => ({ ...dispatch, status: 'reported' as const })),
      reportOutbox: {
        enqueue,
        listPending: vi.fn(() => pendingEntries),
        markDelivered,
        pendingCount: vi.fn(() => 0),
      } as never,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported: vi.fn(),
      } as never,
      getFlags: () => ({ workflowsEnabled: true }),
    })

    const result = ops.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      status: 'success',
      text: 'Done',
    })
    ops.drainReportOutbox(workspace.id)

    expect(result.forwarded).toBe(false)
    expect(deliverSystemMessageToAgent).toHaveBeenCalledTimes(1)

    resolveDelivery()
    await tick()

    expect(markDelivered).toHaveBeenCalledWith(1)
  })

  test('statusTask returns delivering before writeStatusPrompt settles', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    let settled = false
    let resolveDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = () => {
        settled = true
        resolve()
      }
    })
    const writeStatusPrompt = vi.fn(() => delivery)
    const insertMessage = vi.fn(() => ({ sequence: 1 }))

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        writeStatusPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage,
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
      } as never,
    })

    const result = ops.statusTask(workspace.id, worker.id, {
      requireActiveRun: true,
      text: 'connected and waiting for work',
    })

    expect(result).toEqual({
      deliveryState: 'delivering',
      dispatch: null,
      forwardError: null,
      forwarded: false,
    })
    expect(settled).toBe(false)
    expect(writeStatusPrompt).toHaveBeenCalledTimes(1)
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'status',
        text: 'connected and waiting for work',
      })
    )
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(0)

    resolveDelivery()
    await tick()
    expect(settled).toBe(true)
  })

  test('statusTask returns failed with sanitized sync forward error', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const writeStatusPrompt = vi.fn(() => {
      throw new Error('No active run for agent: orch')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secretText = 'sync-fail secret status body'

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        writeStatusPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
      } as never,
    })

    const result = ops.statusTask(workspace.id, worker.id, {
      artifacts: ['/tmp/sync-secret.diff'],
      requireActiveRun: true,
      text: secretText,
    })

    expect(result).toEqual({
      deliveryState: 'failed',
      dispatch: null,
      forwardError: 'No active run for agent: orch',
      forwarded: false,
    })
    expect(consoleError).toHaveBeenCalledWith(
      '[hive] swallowed:teamStatus.forward',
      expect.objectContaining({
        workspaceId: workspace.id,
        workerId: worker.id,
        error: 'No active run for agent: orch',
      })
    )
    const logArg = consoleError.mock.calls.find(
      (call) => call[0] === '[hive] swallowed:teamStatus.forward'
    )?.[1]
    expect(JSON.stringify(logArg)).not.toContain(secretText)
    expect(JSON.stringify(logArg)).not.toContain('/tmp/sync-secret.diff')
  })

  test('statusTask logs sanitized diagnostics when async status forward fails', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    let rejectDelivery!: (error: Error) => void
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject
    })
    const writeStatusPrompt = vi.fn(() => delivery)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ops = createTeamOperations({
      ...operationDependencies(),
      agentRuntime: {
        writeStatusPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      claimQueuedDispatch: vi.fn(() => true),
      reparkClaimedDispatch: vi.fn(() => true),
      listOpenWorkspaceDispatches: vi.fn(() => []),
      markDispatchReportedByWorker: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
      } as never,
    })

    const secretText = 'secret status body with artifacts hint'
    const result = ops.statusTask(workspace.id, worker.id, {
      artifacts: ['/tmp/secret-artifact.diff'],
      requireActiveRun: true,
      text: secretText,
    })

    expect(result.deliveryState).toBe('delivering')
    expect(result.forwarded).toBe(false)
    expect(result.forwardError).toBeNull()

    rejectDelivery(new Error('PTY exited while queued'))
    await tick()

    expect(consoleError).toHaveBeenCalledWith(
      '[hive] swallowed:teamStatus.forward',
      expect.objectContaining({
        workspaceId: workspace.id,
        workerId: worker.id,
        error: 'PTY exited while queued',
      })
    )
    const logArg = consoleError.mock.calls.find(
      (call) => call[0] === '[hive] swallowed:teamStatus.forward'
    )?.[1]
    expect(JSON.stringify(logArg)).not.toContain(secretText)
    expect(JSON.stringify(logArg)).not.toContain('/tmp/secret-artifact.diff')
  })
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const makeDrainOps = (overrides: {
  agentRuntime: Record<string, unknown>
  reportOutbox: Record<string, unknown>
}) =>
  createTeamOperations({
    agentRuntime: overrides.agentRuntime as never,
    createDispatch: vi.fn(),
    deleteDispatch: vi.fn(),
    deleteMessage: vi.fn(),
    findOpenDispatch: vi.fn(),
    findOpenDispatchById: vi.fn(),
    listOpenWorkspaceDispatches: vi.fn(() => []),
    insertMessage: vi.fn(),
    markDispatchCancelled: vi.fn(),
    claimQueuedDispatch: vi.fn(() => true),
    reparkClaimedDispatch: vi.fn(() => true),
    markDispatchReportedByWorker: vi.fn(),
    reportOutbox: overrides.reportOutbox as never,
    workflowDispatchAwaiter: { notifyReport: vi.fn(), notifyCancel: vi.fn() } as never,
    workspaceStore: {} as never,
  })

describe('report outbox drain', () => {
  test('delivers each pending report to an active orchestrator and marks it delivered', async () => {
    const deliver = vi.fn(() => Promise.resolve())
    const markDelivered = vi.fn()
    const ops = makeDrainOps({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'orch-run' })),
        deliverSystemMessageToAgent: deliver,
      },
      reportOutbox: {
        listPending: vi.fn(() => [
          { id: 1, payload: 'report-one' },
          { id: 2, payload: 'report-two' },
        ]),
        markDelivered,
      },
    })

    ops.drainReportOutbox('ws-1')
    await tick()

    expect(deliver).toHaveBeenNthCalledWith(1, 'ws-1', 'ws-1:orchestrator', 'report-one', {
      requireActiveRun: true,
    })
    expect(deliver).toHaveBeenNthCalledWith(2, 'ws-1', 'ws-1:orchestrator', 'report-two', {
      requireActiveRun: true,
    })
    expect(markDelivered).toHaveBeenCalledWith(1)
    expect(markDelivered).toHaveBeenCalledWith(2)
  })

  test('delivers pending notices to the requested active agent target', async () => {
    const deliver = vi.fn(() => Promise.resolve())
    const listPending = vi.fn(() => [{ id: 9, payload: 'issuer-notice' }])
    const markDelivered = vi.fn()
    const ops = makeDrainOps({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'worker-run' })),
        deliverSystemMessageToAgent: deliver,
      },
      reportOutbox: {
        listPending,
        markDelivered,
      },
    })

    ops.drainReportOutbox('ws-1', 'worker-1')
    await tick()

    expect(listPending).toHaveBeenCalledWith('ws-1', 'worker-1')
    expect(deliver).toHaveBeenCalledWith('ws-1', 'worker-1', 'issuer-notice', {
      requireActiveRun: true,
    })
    expect(markDelivered).toHaveBeenCalledWith(9)
  })

  test('does nothing when the orchestrator is not running', async () => {
    const deliver = vi.fn(() => Promise.resolve())
    const listPending = vi.fn(() => [{ id: 1, payload: 'report-one' }])
    const markDelivered = vi.fn()
    const ops = makeDrainOps({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        deliverSystemMessageToAgent: deliver,
      },
      reportOutbox: { listPending, markDelivered },
    })

    ops.drainReportOutbox('ws-1')
    await tick()

    expect(deliver).not.toHaveBeenCalled()
    expect(markDelivered).not.toHaveBeenCalled()
  })

  test('keeps an entry pending when its redelivery write rejects', async () => {
    const deliver = vi.fn(() => Promise.reject(new Error('PTY gone again')))
    const markDelivered = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const createdAt = Date.now() - 5000
    const ops = makeDrainOps({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'orch-run' })),
        deliverSystemMessageToAgent: deliver,
      },
      reportOutbox: {
        listPending: vi.fn(() => [
          {
            id: 1,
            workspaceId: 'ws-1',
            targetAgentId: 'ws-1:orchestrator',
            payload: 'report-one',
            createdAt,
          },
        ]),
        markDelivered,
      },
    })

    ops.drainReportOutbox('ws-1')
    await tick()

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(markDelivered).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      '[hive] swallowed:teamReport.outboxDrain',
      expect.objectContaining({
        workspaceId: 'ws-1',
        targetAgentId: 'ws-1:orchestrator',
        pendingCount: 1,
        oldestPendingWaitMs: expect.any(Number),
        error: 'PTY gone again',
      })
    )
    const logArg = consoleError.mock.calls.find(
      (call) => call[0] === '[hive] swallowed:teamReport.outboxDrain'
    )?.[1] as { oldestPendingWaitMs: number; error: string }
    expect(logArg.oldestPendingWaitMs).toBeGreaterThanOrEqual(5000)
    expect(JSON.stringify(logArg)).not.toContain('report-one')
  })
})
