import { describe, expect, test, vi } from 'vitest'

import {
  closeWorkflowAgentBudget,
  createWorkflowAgentBudget,
  createWorkflowAgentCallExecutor,
  type WorkflowAgentBudget,
} from '../../src/server/workflow-agent-call-executor.js'
import { DEFAULT_WORKFLOW_CLI_POLICY } from '../../src/server/workflow-cli-policy.js'
import {
  createWorkflowDispatchAwaiter,
  type WorkflowDispatchAwaiter,
} from '../../src/server/workflow-dispatch-awaiter.js'

const createGate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const createExecutor = (
  overrides: {
    assertRunActive?: () => void
    startAgent?: ReturnType<typeof vi.fn>
    dispatchTaskByWorkerName?: ReturnType<typeof vi.fn>
    awaitReport?: ReturnType<typeof vi.fn>
    awaiter?: WorkflowDispatchAwaiter
    cancelOpenDispatch?: ReturnType<typeof vi.fn>
    maxConcurrentAgents?: number
    budget?: WorkflowAgentBudget
  } = {}
) => {
  const addWorkerWithLaunch = vi.fn(() => ({ id: 'worker-1', name: 'worker-1' }))
  const deleteWorker = vi.fn()
  const startAgent =
    overrides.startAgent ?? vi.fn(async () => ({ postStartInputReady: Promise.resolve() }))
  const dispatchTaskByWorkerName =
    overrides.dispatchTaskByWorkerName ?? vi.fn(async () => ({ id: 'dispatch-1' }))
  const awaitReport =
    overrides.awaitReport ?? vi.fn(async () => ({ artifacts: [], text: 'reported' }))
  const awaiter =
    overrides.awaiter ??
    ({
      awaitReport,
      cancelAll: vi.fn(),
      forceCancel: vi.fn(),
      notifyCancel: vi.fn(),
      notifyReport: vi.fn(),
    } satisfies WorkflowDispatchAwaiter)
  const cancelOpenDispatch = overrides.cancelOpenDispatch ?? vi.fn()
  const executor = createWorkflowAgentCallExecutor({
    assertRunActive: overrides.assertRunActive ?? vi.fn(),
    awaiter,
    cancelOpenDispatch,
    cliPolicy: DEFAULT_WORKFLOW_CLI_POLICY,
    getCurrentPhaseTitle: () => null,
    hivePort: '0',
    isRunStopped: () => false,
    ...(overrides.budget ? { budget: overrides.budget } : {}),
    ...(overrides.maxConcurrentAgents !== undefined
      ? { maxConcurrentAgents: overrides.maxConcurrentAgents }
      : {}),
    registerDagDispatch: vi.fn(),
    resolveCliLaunchConfig: () => ({ args: [], command: 'claude' }),
    roleTemplateResolver: { findByName: () => undefined },
    runId: 'run-1',
    store: {
      addWorkerWithLaunch,
      deleteWorker,
      dispatchTaskByWorkerName,
      startAgent,
    },
    workflowAgentId: 'workspace-1:workflow',
    workflowName: 'test-workflow',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/ws',
  })
  return {
    addWorkerWithLaunch,
    awaiter,
    awaitReport,
    cancelOpenDispatch,
    deleteWorker,
    dispatchTaskByWorkerName,
    executor,
    startAgent,
  }
}

describe('createWorkflowAgentCallExecutor', () => {
  test.each([
    'own',
    'parent',
  ] as const)('closing the %s budget settles a call still waiting for startup readiness', async (scope) => {
    const parent = createWorkflowAgentBudget({})
    const budget = createWorkflowAgentBudget({}, parent)
    const started = createGate()
    const startup = createGate()
    const { executor } = createExecutor({
      budget,
      startAgent: vi.fn(async () => ({
        get postStartInputReady() {
          started.release()
          return startup.promise
        },
      })),
    })
    const outcome = executor.agent('cancel before ready').then(
      (value) => ({ status: 'resolved', value }),
      (error: unknown) => ({ status: 'rejected', error })
    )
    try {
      await started.promise
      closeWorkflowAgentBudget(scope === 'own' ? budget : parent, 'Stopped by user')
      await expect(executor.waitForActiveCalls(100)).resolves.toEqual({
        settled: true,
        activeCount: 0,
      })
      expect(await outcome).toEqual({ status: 'rejected', error: expect.any(Error) })
      expect(budget.inFlight).toBe(0)
      expect(parent.inFlight).toBe(0)
    } finally {
      startup.release()
      await outcome
    }
  })

  test('does not create a late dispatch after the run stops during worker startup', async () => {
    const startupGate = createGate()
    let active = true
    const assertRunActive = vi.fn(() => {
      if (!active) throw new Error('boom')
    })
    const { deleteWorker, dispatchTaskByWorkerName, executor } = createExecutor({
      assertRunActive,
      startAgent: vi.fn(async () => ({ postStartInputReady: startupGate.promise })),
    })

    const call = executor.agent('late sidecar')
    await vi.waitFor(() => expect(assertRunActive).toHaveBeenCalledTimes(3))
    active = false
    startupGate.release()

    await expect(call).rejects.toThrow(/boom/)
    expect(dispatchTaskByWorkerName).not.toHaveBeenCalled()
    expect(deleteWorker).toHaveBeenCalledWith('workspace-1', 'worker-1')
  })

  test('cancels a dispatch created just before the run stop is observed', async () => {
    let activeChecks = 0
    const assertRunActive = vi.fn(() => {
      activeChecks += 1
      if (activeChecks >= 5) throw new Error('boom')
    })
    const { awaitReport, cancelOpenDispatch, executor } = createExecutor({ assertRunActive })

    await expect(executor.agent('late dispatch')).rejects.toThrow(/boom/)
    expect(awaitReport).not.toHaveBeenCalled()
    expect(cancelOpenDispatch).toHaveBeenCalledWith('dispatch-1', 'boom')
  })

  test('bounds active call cleanup and can force-cancel local awaiters', async () => {
    const awaiter = createWorkflowDispatchAwaiter()
    const { dispatchTaskByWorkerName, executor } = createExecutor({ awaiter })

    const call = executor.agent('hung dispatch')
    await vi.waitFor(() => expect(dispatchTaskByWorkerName).toHaveBeenCalled())

    await expect(executor.waitForActiveCalls(1)).resolves.toMatchObject({
      settled: false,
      activeCount: 1,
    })

    executor.forceCancelActiveDispatchWaiters('cleanup timed out')
    await expect(call).rejects.toThrow(/cleanup timed out/)
    await expect(executor.waitForActiveCalls(100)).resolves.toMatchObject({
      settled: true,
      activeCount: 0,
    })
  })

  test('force-cancels agent calls queued for a concurrency slot', async () => {
    const startupGate = createGate()
    const { addWorkerWithLaunch, executor } = createExecutor({
      maxConcurrentAgents: 1,
      startAgent: vi.fn(async () => ({ postStartInputReady: startupGate.promise })),
    })

    const first = executor.agent('first')
    const queued = executor.agent('queued')
    await vi.waitFor(() => expect(addWorkerWithLaunch).toHaveBeenCalledTimes(1))

    executor.forceCancelActiveDispatchWaiters('cleanup timed out')
    await expect(queued).rejects.toThrow(/cleanup timed out/)
    expect(addWorkerWithLaunch).toHaveBeenCalledTimes(1)

    startupGate.release()
    await expect(first).resolves.toBe('reported')
    await expect(executor.waitForActiveCalls(100)).resolves.toMatchObject({
      settled: true,
      activeCount: 0,
    })
  })

  test('cancels only queued calls for the failed DAG layer', async () => {
    const startupGate = createGate()
    const { addWorkerWithLaunch, executor } = createExecutor({
      maxConcurrentAgents: 1,
      startAgent: vi.fn(async () => ({ postStartInputReady: startupGate.promise })),
    })

    const active = executor.agent('active layer a', { __hiveDagLayerId: 'layer-a' })
    const cancelled = executor.agent('queued layer a', { __hiveDagLayerId: 'layer-a' })
    const laterLayer = executor.agent('queued layer b', { __hiveDagLayerId: 'layer-b' })
    await vi.waitFor(() => expect(addWorkerWithLaunch).toHaveBeenCalledTimes(1))

    executor.cancelQueuedAgentCallsForDagLayer('layer-a', 'DAG node failed: boom')
    await expect(cancelled).rejects.toThrow(/DAG node failed: boom/)
    expect(addWorkerWithLaunch).toHaveBeenCalledTimes(1)

    startupGate.release()
    await expect(active).resolves.toBe('reported')
    await expect(laterLayer).resolves.toBe('reported')
    expect(addWorkerWithLaunch).toHaveBeenCalledTimes(2)
  })
})
