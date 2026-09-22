import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'

import { isWorkerRole, type WorkerRole } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { resolveWorkflowCli, type WorkflowCliPolicy } from './workflow-cli-policy.js'
import type { WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'
import { buildSchemaInstruction, extractJsonBlock } from './workflow-output-schema.js'
import {
  applyWorkflowWorktreeMeta,
  buildWorktreeDispatchPreamble,
  cleanupWorkflowWorktree,
  createWorkflowWorktree,
  type WorkflowWorktreeHandle,
} from './workflow-worktree.js'

const DEFAULT_MAX_AGENTS_PER_RUN = 1000
const DEFAULT_MAX_CONCURRENT_AGENTS = Math.min(16, Math.max(2, cpus().length - 2))

interface WorkflowSlotWaiter {
  scope: WorkflowAgentBudget
  dagLayerId: string | null
  reject: (error: Error) => void
  resolve: (release: () => void) => void
}

/** Host-only admission state. Script/HTTP inputs never carry this object. */
export interface WorkflowAgentBudget {
  parent?: WorkflowAgentBudget
  maxCalls: number
  calls: number
  maxConcurrent: number
  inFlight: number
  closed: string | null
  abortController: AbortController
  queue: WorkflowSlotWaiter[]
}

export const createWorkflowAgentBudget = (
  limits: { maxAgentCalls?: number; maxConcurrentAgents?: number },
  parent?: WorkflowAgentBudget
): WorkflowAgentBudget => ({
  ...(parent ? { parent } : {}),
  maxCalls:
    typeof limits.maxAgentCalls === 'number' && limits.maxAgentCalls > 0
      ? limits.maxAgentCalls
      : DEFAULT_MAX_AGENTS_PER_RUN,
  maxConcurrent:
    typeof limits.maxConcurrentAgents === 'number' && limits.maxConcurrentAgents > 0
      ? limits.maxConcurrentAgents
      : DEFAULT_MAX_CONCURRENT_AGENTS,
  calls: 0,
  inFlight: 0,
  closed: null,
  abortController: new AbortController(),
  queue: parent?.queue ?? [],
})

const budgetAncestors = (scope: WorkflowAgentBudget): WorkflowAgentBudget[] => {
  const ancestors: WorkflowAgentBudget[] = []
  for (let current: WorkflowAgentBudget | undefined = scope; current; current = current.parent) {
    ancestors.push(current)
  }
  return ancestors
}

export const assertWorkflowBudgetActive = (scope: WorkflowAgentBudget) => {
  for (const ancestor of budgetAncestors(scope)) {
    if (ancestor.closed !== null) throw new Error(ancestor.closed)
  }
}

const takeBudgetSlot = (scope: WorkflowAgentBudget): (() => void) => {
  const ancestors = budgetAncestors(scope)
  for (const ancestor of ancestors) ancestor.inFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    for (const ancestor of ancestors) ancestor.inFlight--
    drainBudgetQueue(scope.queue)
  }
}

const drainBudgetQueue = (queue: WorkflowSlotWaiter[]) => {
  for (let i = 0; i < queue.length; ) {
    const waiter = queue[i]
    if (!waiter) break
    const ancestors = budgetAncestors(waiter.scope)
    const closedReason = ancestors.find((ancestor) => ancestor.closed !== null)?.closed
    if (closedReason != null) {
      queue.splice(i, 1)
      waiter.reject(new Error(closedReason))
    } else if (ancestors.every((ancestor) => ancestor.inFlight < ancestor.maxConcurrent)) {
      queue.splice(i, 1)
      waiter.resolve(takeBudgetSlot(waiter.scope))
    } else {
      i++
    }
  }
}

export const closeWorkflowAgentBudget = (scope: WorkflowAgentBudget, reason: string) => {
  scope.closed ??= reason
  scope.abortController.abort(new Error(scope.closed))
  drainBudgetQueue(scope.queue)
}

export interface WorkflowAgentOptions {
  label?: string
  /** Built-in role name OR the name of a workspace-defined custom role template. */
  agentType?: WorkerRole | string
  cli?: string
  timeoutMs?: number
  /** Per-call model override, appended as `--model <id>` after template args. */
  model?: string
  outputSchema?: Record<string, unknown>
  /** `shared` (default) uses the workspace root; `worktree` isolates the call. */
  isolation?: 'shared' | 'worktree'
  __hiveDagLayerId?: string
}

export interface WorkflowRoleTemplateResolver {
  findByName(name: string):
    | {
        name: string
        roleType: WorkerRole | 'orchestrator'
        description: string
        defaultCommand: string
        defaultArgs: string[]
      }
    | undefined
}

export interface WorkflowAgentExecutorStorePort {
  addWorkerWithLaunch: (
    workspaceId: string,
    input: {
      name: string
      role: WorkerRole
      description?: string
      ephemeral: true
      spawnedBy: 'workflow'
    },
    launchConfig: AgentLaunchConfigInput
  ) => { id: string; name: string }
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ) => Promise<{ postStartInputReady?: Promise<void> }>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input: {
      fromAgentId: string
      hivePort: string
      workflowRunId: string
      stepIndex: number
      phase?: string
      label?: string
    }
  ) => Promise<{ id: string }>
  deleteWorker: (workspaceId: string, workerId: string) => void
}

interface CreateWorkflowAgentCallExecutorInput {
  assertRunActive: () => void
  awaiter: WorkflowDispatchAwaiter
  cancelOpenDispatch: (dispatchId: string, reason: string) => void
  cliPolicy: WorkflowCliPolicy
  getCurrentPhaseTitle: () => string | null
  hivePort: string
  isRunStopped: () => boolean
  maxAgentCalls?: number
  maxConcurrentAgents?: number
  budget?: WorkflowAgentBudget
  registerDagDispatch: (layerId: string | null, dispatchId: string) => void
  resolveCliLaunchConfig: (cli: string) => AgentLaunchConfigInput | undefined
  roleTemplateResolver: WorkflowRoleTemplateResolver
  runId: string
  store: WorkflowAgentExecutorStorePort
  workflowAgentId: string
  workflowName: string
  workspaceId: string
  workspacePath: string
}

const buildModelArgs = (_cli: string, model: string | undefined): string[] => {
  if (!model?.trim()) return []
  /* All supported CLIs accept `--model <id>` as a positional flag. Keeping
     the mapping centralised here so future CLI quirks can be patched without
     touching workflow run lifecycle code. */
  return ['--model', model]
}

export const createWorkflowAgentCallExecutor = ({
  assertRunActive,
  awaiter,
  cancelOpenDispatch,
  cliPolicy,
  getCurrentPhaseTitle,
  hivePort,
  isRunStopped,
  maxAgentCalls,
  maxConcurrentAgents: configuredMaxConcurrentAgents,
  budget: suppliedBudget,
  registerDagDispatch,
  resolveCliLaunchConfig,
  roleTemplateResolver,
  runId,
  store,
  workflowAgentId,
  workflowName,
  workspaceId,
  workspacePath,
}: CreateWorkflowAgentCallExecutorInput) => {
  let stepCounter = 0
  const spawnedWorkers: string[] = []
  const activeAgentCalls = new Set<Promise<void>>()
  const activeDispatchIds = new Set<string>()
  const budget =
    suppliedBudget ??
    createWorkflowAgentBudget({
      ...(maxAgentCalls !== undefined ? { maxAgentCalls } : {}),
      ...(configuredMaxConcurrentAgents !== undefined
        ? { maxConcurrentAgents: configuredMaxConcurrentAgents }
        : {}),
    })
  const acquireSlot = async (dagLayerId: string | null): Promise<() => void> => {
    assertWorkflowBudgetActive(budget)
    if (budgetAncestors(budget).every((scope) => scope.inFlight < scope.maxConcurrent)) {
      return takeBudgetSlot(budget)
    }
    return new Promise((resolve, reject) => {
      budget.queue.push({ scope: budget, dagLayerId, resolve, reject })
    })
  }
  const cancelQueuedSlotWaiters = (
    reason: string,
    predicate: (waiter: WorkflowSlotWaiter) => boolean
  ) => {
    for (let i = 0; i < budget.queue.length; ) {
      const waiter = budget.queue[i]
      if (!waiter) break
      if (waiter.scope === budget && predicate(waiter)) {
        budget.queue.splice(i, 1)
        waiter.reject(new Error(reason))
      } else {
        i++
      }
    }
    drainBudgetQueue(budget.queue)
  }

  const resolveWorkerLaunch = (opts: WorkflowAgentOptions) => {
    const requestedType = opts.agentType ?? 'coder'
    let role: WorkerRole
    let description: string | undefined
    let command: string
    let templateArgs: string[] = []
    if (typeof requestedType === 'string' && !isWorkerRole(requestedType)) {
      const template = roleTemplateResolver.findByName(requestedType)
      if (!template) {
        throw new Error(
          `Workflow agentType '${requestedType}' is not a built-in role (coder/reviewer/tester/custom) and no matching role template exists in this workspace. ` +
            `Use a built-in role or an existing dispatchable role template.`
        )
      }
      role = template.roleType === 'orchestrator' ? 'custom' : template.roleType
      description = template.description
      command = resolveWorkflowCli({
        ...(opts.cli !== undefined ? { requestedCli: opts.cli } : {}),
        isCustomTemplate: true,
        templateDefaultCommand: template.defaultCommand,
        policy: cliPolicy,
      })
      templateArgs = template.defaultArgs
    } else {
      role = requestedType as WorkerRole
      command = resolveWorkflowCli({
        ...(opts.cli !== undefined ? { requestedCli: opts.cli } : {}),
        isCustomTemplate: false,
        policy: cliPolicy,
      })
    }

    const baseLaunchConfig = resolveCliLaunchConfig(command) ?? { command, args: [] }
    const launchArgs = [
      ...(baseLaunchConfig.args ?? []),
      ...templateArgs,
      ...buildModelArgs(baseLaunchConfig.command, opts.model),
    ]
    return {
      requestedType,
      role,
      description,
      launchConfig: { ...baseLaunchConfig, args: launchArgs },
    }
  }

  const agent = async (
    prompt: string,
    opts: WorkflowAgentOptions = {}
  ): Promise<string | Record<string, unknown>> => {
    let markAgentCallDone!: () => void
    const agentCallDone = new Promise<void>((resolve) => {
      markAgentCallDone = resolve
    })
    activeAgentCalls.add(agentCallDone)
    try {
      assertRunActive()
      assertWorkflowBudgetActive(budget)
      const ancestors = budgetAncestors(budget)
      for (const scope of ancestors) {
        if (scope.calls >= scope.maxCalls) {
          throw new Error(
            `Workflow agent cap exceeded: ${scope.maxCalls} calls (including descendants)`
          )
        }
      }
      for (const scope of ancestors) scope.calls++
      const myStep = ++stepCounter
      const dagLayerId =
        typeof opts.__hiveDagLayerId === 'string' && opts.__hiveDagLayerId.trim()
          ? opts.__hiveDagLayerId.trim()
          : null
      const {
        launchConfig: baseLaunchConfig,
        requestedType,
        role,
        description,
      } = resolveWorkerLaunch(opts)
      const name = opts.label ?? `${requestedType}-${myStep}-${randomUUID()}`

      const releaseSlot = await acquireSlot(dagLayerId)
      let worker: { id: string; name: string } | undefined
      let dispatchId: string | undefined
      let worktree: WorkflowWorktreeHandle | undefined
      let result: string | Record<string, unknown> | undefined
      try {
        assertRunActive()
        assertWorkflowBudgetActive(budget)
        let launchConfig = baseLaunchConfig
        if (opts.isolation === 'worktree') {
          worktree = await createWorkflowWorktree({
            label: opts.label ?? String(requestedType),
            runId,
            step: myStep,
            workspaceId,
            workspacePath,
          })
          launchConfig = { ...launchConfig, cwd: worktree.dir }
        }
        worker = store.addWorkerWithLaunch(
          workspaceId,
          {
            name,
            role,
            ...(description !== undefined ? { description } : {}),
            ephemeral: true,
            spawnedBy: 'workflow',
          },
          launchConfig
        )
        spawnedWorkers.push(worker.id)
        assertRunActive()
        assertWorkflowBudgetActive(budget)
        const liveRun = await store.startAgent(workspaceId, worker.id, { hivePort })
        const signal = AbortSignal.any(
          budgetAncestors(budget).map((scope) => scope.abortController.signal)
        )
        signal.throwIfAborted()
        let onAbort: () => void = () => {}
        try {
          await new Promise<void>((resolve, reject) => {
            onAbort = () => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
            Promise.resolve(liveRun.postStartInputReady).then(resolve, reject)
          })
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        assertRunActive()
        assertWorkflowBudgetActive(budget)
        const schemaTail = opts.outputSchema ? buildSchemaInstruction(opts.outputSchema) : ''
        const dispatchPrompt = `${worktree ? buildWorktreeDispatchPreamble(worktree) : ''}${prompt}${schemaTail}`
        const currentPhaseTitle = getCurrentPhaseTitle()
        const dispatch = await store.dispatchTaskByWorkerName(workspaceId, name, dispatchPrompt, {
          fromAgentId: workflowAgentId,
          hivePort,
          workflowRunId: runId,
          stepIndex: myStep,
          ...(currentPhaseTitle ? { phase: currentPhaseTitle } : {}),
          label: opts.label ?? name,
        })
        dispatchId = dispatch.id
        activeDispatchIds.add(dispatch.id)
        registerDagDispatch(dagLayerId, dispatch.id)
        assertRunActive()
        assertWorkflowBudgetActive(budget)
        const report = await awaiter.awaitReport(dispatch.id, opts.timeoutMs)
        assertRunActive()
        assertWorkflowBudgetActive(budget)
        result = opts.outputSchema
          ? (extractJsonBlock(report.text) ?? { text: report.text })
          : report.text
      } catch (error) {
        if (dispatchId) {
          try {
            cancelOpenDispatch(dispatchId, error instanceof Error ? error.message : String(error))
          } catch (cancelError) {
            console.error('[hive] swallowed:workflow.agent.cancelDispatch', cancelError)
          }
        }
        throw error
      } finally {
        if (dispatchId) activeDispatchIds.delete(dispatchId)
        if (worker) {
          try {
            store.deleteWorker(workspaceId, worker.id)
          } catch {
            /* idempotent — worker may already be gone via cascade or boot cleanup */
          }
          const idx = spawnedWorkers.indexOf(worker.id)
          if (idx !== -1) spawnedWorkers.splice(idx, 1)
        }
        try {
          if (worktree) {
            const meta = await cleanupWorkflowWorktree(worktree)
            if (result !== undefined) result = applyWorkflowWorktreeMeta(result, meta)
          }
        } finally {
          releaseSlot()
        }
      }
      return result as string | Record<string, unknown>
    } finally {
      markAgentCallDone()
      activeAgentCalls.delete(agentCallDone)
    }
  }

  const catchPerItem = <U>(value: unknown): U | null => {
    if (isRunStopped()) throw value
    console.warn(`[workflow ${workflowName}] item failed:`, value)
    return null
  }

  const waitForActiveCalls = async (
    timeoutMs?: number
  ): Promise<{ settled: boolean; activeCount: number }> => {
    const calls = [...activeAgentCalls]
    if (calls.length === 0) {
      return { settled: true, activeCount: 0 }
    }
    if (timeoutMs === undefined) {
      await Promise.allSettled(calls)
      return { settled: true, activeCount: 0 }
    }

    let timeoutHandle: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const result = await Promise.race([
      Promise.allSettled(calls).then(() => 'settled' as const),
      timeout,
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    return {
      settled: result === 'settled',
      activeCount: activeAgentCalls.size,
    }
  }

  const forceCancelActiveDispatchWaiters = (reason: string) => {
    for (const dispatchId of activeDispatchIds) {
      awaiter.forceCancel(dispatchId, reason)
    }
    cancelQueuedSlotWaiters(reason, () => true)
  }

  const cancelQueuedAgentCallsForDagLayer = (layerId: string, reason: string) => {
    const normalized = layerId.trim()
    if (!normalized) return
    cancelQueuedSlotWaiters(reason, (waiter) => waiter.dagLayerId === normalized)
  }

  const deleteSpawnedWorkers = () => {
    for (const workerId of spawnedWorkers.splice(0)) {
      try {
        store.deleteWorker(workspaceId, workerId)
      } catch {
        /* swallow */
      }
    }
  }

  return {
    agent,
    cancelQueuedAgentCallsForDagLayer,
    catchPerItem,
    deleteSpawnedWorkers,
    forceCancelActiveDispatchWaiters,
    waitForActiveCalls,
  }
}
