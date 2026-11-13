import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentRuntime } from '../../src/server/agent-runtime-contract.js'
import {
  createDispatchLedgerStore,
  type DispatchRecord,
} from '../../src/server/dispatch-ledger-store.js'
import { createReportOutboxDelivery } from '../../src/server/report-outbox-delivery.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations, type TeamOperationsInput } from '../../src/server/team-operations.js'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'

const operationDatabases: Database[] = []
afterEach(() => {
  vi.useRealTimers()
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

// Report acceptance/ledger rollback and real PTY delivery are covered by
// tests/server/team-report-outbox-route.test.ts and agent-inbox-{delivery,failure}.test.ts.
// These unit tests isolate batching against a real SQLite queue and observable output.
const reportDeliveryHarness = () => {
  const outbox = createReportOutboxStore(operationDatabase())
  const received: Array<{ workspaceId: string; target: string; payload: string }> = []
  let active = true
  let failure: Error | undefined
  let acknowledgement: Promise<void> | undefined
  const runtime = {
    getActiveRunByAgentId: () => (active ? { runId: 'real-queue-sink' } : undefined),
    deliverSystemMessageToAgent: async (workspaceId, target, payload) => {
      const text = typeof payload === 'function' ? payload() : payload
      if (text === undefined) return
      if (failure) throw failure
      if (acknowledgement) await acknowledgement
      received.push({ workspaceId, target, payload: text })
    },
  } as Pick<AgentRuntime, 'getActiveRunByAgentId' | 'deliverSystemMessageToAgent'>
  const drain = createReportOutboxDelivery({
    outbox,
    runtime: runtime as AgentRuntime,
    isClosing: () => false,
  })
  return {
    outbox,
    received,
    drain,
    setActive: (value: boolean) => {
      active = value
    },
    setFailure: (value: Error | undefined) => {
      failure = value
    },
    setAcknowledgement: (value: Promise<void>) => {
      acknowledgement = value
    },
    enqueue: (id: string, payload: string, target = 'ws-1:orchestrator') =>
      outbox.enqueue({ workspaceId: 'ws-1', targetAgentId: target, dispatchId: id, payload }),
  }
}

describe('report outbox batching with durable queue', () => {
  test('combines queued reports and marks their SQLite rows delivered only after the batch window', async () => {
    vi.useFakeTimers()
    const harness = reportDeliveryHarness()
    harness.enqueue('d1', 'First accepted report')
    harness.enqueue('d2', 'Second accepted report')
    harness.drain('ws-1')
    await vi.advanceTimersByTimeAsync(349)
    expect(harness.outbox.pendingCount('ws-1', 'ws-1:orchestrator')).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.received).toEqual([
      {
        workspaceId: 'ws-1',
        target: 'ws-1:orchestrator',
        payload: 'First accepted report\n\nSecond accepted report',
      },
    ])
    expect(harness.outbox.pendingCount('ws-1', 'ws-1:orchestrator')).toBe(0)
  })

  test('a reentrant drain cannot duplicate a batch whose downstream acknowledgement is pending', async () => {
    vi.useFakeTimers()
    const harness = reportDeliveryHarness()
    let acknowledge!: () => void
    harness.setAcknowledgement(
      new Promise<void>((resolve) => {
        acknowledge = resolve
      })
    )
    harness.enqueue('d1', 'Retain until acknowledged')
    harness.drain('ws-1')
    await vi.advanceTimersByTimeAsync(350)
    harness.drain('ws-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.outbox.pendingCount('ws-1', 'ws-1:orchestrator')).toBe(1)
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    harness.drain('ws-1')
    await vi.advanceTimersByTimeAsync(350)
    expect(harness.received.map((entry) => entry.payload)).toEqual(['Retain until acknowledged'])
    expect(harness.outbox.pendingCount('ws-1', 'ws-1:orchestrator')).toBe(0)
  })

  test('offline and failed output leave durable notices pending for a later successful targeted drain', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = reportDeliveryHarness()
    harness.enqueue('notice', 'Durable issuer notice', 'worker-1')
    harness.setActive(false)
    harness.drain('ws-1', 'worker-1')
    await vi.advanceTimersByTimeAsync(350)
    expect(harness.outbox.pendingCount('ws-1', 'worker-1')).toBe(1)
    harness.setActive(true)
    harness.setFailure(new Error('Downstream is unavailable'))
    harness.drain('ws-1', 'worker-1')
    await vi.advanceTimersByTimeAsync(350)
    expect(harness.outbox.pendingCount('ws-1', 'worker-1')).toBe(1)
    harness.setFailure(undefined)
    harness.drain('ws-1', 'worker-1')
    await vi.advanceTimersByTimeAsync(350)
    expect(harness.received).toEqual([
      { workspaceId: 'ws-1', target: 'worker-1', payload: 'Durable issuer notice' },
    ])
    expect(harness.outbox.pendingCount('ws-1', 'worker-1')).toBe(0)
  })
})
