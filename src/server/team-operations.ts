import type { TeamListItem } from '../shared/types.js'
import type { AgentRuntime } from './agent-runtime.js'
import {
  buildOrchestratorReportPayload,
  type SendPromptWrite,
  utf8ByteLength,
} from './agent-stdin-dispatcher.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { FEATURE_FLAGS_ALL_OFF, type FeatureFlags } from './feature-flags.js'
import { escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import { ConflictError, ForbiddenError, PromptReadinessTimeoutError } from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import type { ReportOutboxStore } from './report-outbox-store.js'
import {
  createReportMessage,
  createSendMessage,
  createStatusMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { WebhookEvent } from './webhook-notifier.js'
import type { WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'
import type { WorkspaceStore } from './workspace-store.js'
import { getWorkflowAgentId } from './workspace-store-support.js'

/* Roster snapshot embedded in the 409 the orchestrator sees when it
   dispatches to a missing name. Format prioritizes the orchestrator's
   parsing path: bullet-per-member with role + live status + pending
   count, plus an explicit retry hint that names both fix-up paths
   (direct send to a listed name, or re-`team list` if it doubts the
   snapshot). Keeping role/status/pending inline saves a follow-up
   `team list` round-trip — the orchestrator can re-pick in the same
   turn. */
export const formatUnknownWorkerError = (
  workerName: string,
  roster: readonly TeamListItem[]
): string => {
  if (roster.length === 0) {
    return [
      `Unknown worker "${workerName}": this workspace currently has no workers.`,
      'Report the empty roster to the user and recommend the worker role to add. If the user or workspace policy has explicitly authorized autonomous staffing, run `team spawn <role> [--name <name>] [--ephemeral]`, then `team list` and retry with the spawned worker name.',
    ].join('\n')
  }
  const lines = roster.map(
    (entry) =>
      `  - ${entry.name} (${entry.role}, ${entry.status}, ${entry.pendingTaskCount} pending)`
  )
  return [
    `Unknown worker "${workerName}" in this workspace. Current members:`,
    ...lines,
    'Retry with `team send "<one of the names above>" "<task>"`, or run `team list` to refresh the roster.',
  ].join('\n')
}

/* Worker-facing 409 for `team report`. The same generic "no open dispatch"
   used to cover two very different states: (a) the worker passed a --dispatch
   id that is wrong or already closed while OTHER dispatches are still open —
   recoverable in one retry if we list the real ids; (b) the worker truly has
   nothing open — the right move is `team status`, not a report retry loop. */
export const formatNoOpenDispatchError = (
  workerName: string,
  requestedDispatchId: string | undefined,
  openDispatches: readonly DispatchRecord[]
): string => {
  if (requestedDispatchId !== undefined && openDispatches.length > 0) {
    const lines = openDispatches.map(
      (dispatch) =>
        `  - ${dispatch.id} (${dispatch.status}): ${dispatch.text.slice(0, 60)}${dispatch.text.length > 60 ? '…' : ''}`
    )
    return [
      `Dispatch ${requestedDispatchId} is not open for worker ${workerName}. Your open dispatches:`,
      ...lines,
      'Do not change the dispatch ID to settle an unrelated task. Inspect this responsibility with `team messages --dispatch <id>`; if it is already closed, do not report it again. Ask the orchestrator for a related responsibility if further work is needed.',
    ].join('\n')
  }
  const submitted = openDispatches.filter((dispatch) => dispatch.status === 'submitted')
  if (requestedDispatchId === undefined && submitted.length > 1) {
    const lines = submitted.map(
      (dispatch) =>
        `  - ${dispatch.id} (${dispatch.status}): ${dispatch.text.slice(0, 60)}${dispatch.text.length > 60 ? '…' : ''}`
    )
    return [
      `Worker ${workerName} has more than one submitted dispatch. Report with \`team report --dispatch <id>\`:`,
      ...lines,
    ].join('\n')
  }
  return (
    `No open dispatch for worker: ${workerName}. Nothing is awaiting your report — ` +
    'if you have progress or standby info to share, use `team status "<state>"` instead.'
  )
}

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  createDispatch: (input: {
    delegatedFromId?: string
    fromAgentId?: string
    label?: string
    relatedToDispatchId?: string
    phase?: string
    stepIndex?: number
    text: string
    toAgentId: string
    workflowRunId?: string
    workspaceId: string
  }) => DispatchRecord
  deleteDispatch: (dispatchId: string) => void
  deleteMessage: (handle: MessageLogHandle) => void
  findOpenDispatch: (
    workspaceId: string,
    toAgentId: string,
    dispatchId?: string
  ) => DispatchRecord | undefined
  findOpenDispatchById: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  listOpenWorkspaceDispatches: (workspaceId: string) => DispatchRecord[]
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  markDispatchCancelled: (input: {
    dispatchId: string
    reason: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchReportedByWorker: (input: {
    ackBatchId?: string
    outcome?: 'success' | 'failed'
    artifacts: string[]
    dispatchId?: string
    seenSeq?: number
    reportText: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  /** Atomic queued→submitted claim; true means this caller owns delivery. */
  claimQueuedDispatch: (dispatchId: string) => boolean
  /** Revert a claim after a replay write failed before reaching a live PTY. */
  reparkClaimedDispatch: (dispatchId: string) => boolean
  reportOutbox: ReportOutboxStore
  /** Fire an outbound completion webhook (best-effort) when a worker reports. */
  notifyWebhook?: (event: WebhookEvent) => void
  /** Runs durable protocol writes atomically when backed by SQLite. */
  runDataMutation?: (mutation: () => void) => void
  /** True once runtime shutdown has begun; late async PTY callbacks must not touch SQLite. */
  isRuntimeClosing?: () => boolean
  workflowDispatchAwaiter: WorkflowDispatchAwaiter
  workspaceStore: WorkspaceStore
  /** Auto-dismiss an ephemeral orchestrator-spawned worker after its
   *  dispatch report. Wired in runtime-store-helpers to remove the worker
   *  completely (stop run, drop launch config, drop the row). M11. */
  dismissEphemeralWorker?: (workspaceId: string, workerId: string) => void
  /** Local retention counter (issue #23). Implementations must never throw —
   *  a stats failure must not break a protocol operation. Optional so unit
   *  fixtures stay minimal. */
  recordProtocolEvent?: (event: 'send' | 'report' | 'status' | 'cancel') => void
  /** Persist send-envelope bytes + delivered_at. Must never throw to callers. */
  markDispatchDelivered?: (input: {
    deliveredAt: number
    dispatchId: string
    dispatchPayloadBytes: number
  }) => void
  /** Persist report-envelope bytes. Must never throw to callers. */
  recordReportPayloadBytes?: (dispatchId: string, bytes: number) => void
  /** Highest message sequence the worker must have seen before reporting on
   *  a dispatch. Non-zero when notes/questions were attached while the
   *  dispatch sat queued, so the (re)played envelope tells the truth. */
  requiredSeenSeq?: (dispatchId: string, workerId: string) => number
  drainDispatchMessages?: (workspaceId: string, agentId: string) => void
  /** Live experimental flags for payloads that are persisted for later replay. */
  getFlags?: () => FeatureFlags
}

export interface DispatchTaskInput {
  delegatedFromId?: string
  relatedToDispatchId?: string
  autoStartWorker?: boolean
  fromAgentId?: string
  hivePort?: string
  workflowRunId?: string
  stepIndex?: number
  phase?: string
  label?: string
}

export interface ReportTaskInput {
  ackBatchId?: string
  seenSeq?: number
  artifacts?: string[]
  dispatchId?: string
  requireActiveRun?: boolean
  status?: 'success' | 'failed'
  text?: string
}

export interface StatusTaskInput {
  artifacts?: string[]
  requireActiveRun?: boolean
  text?: string
}

export interface CancelTaskInput {
  fromAgentId: string
  reason: string
}

export type ReportDeliveryState = 'delivered' | 'delivering' | 'queued' | 'failed'

export interface ReportTaskResult {
  deliveryState?: ReportDeliveryState
  dispatch: DispatchRecord | null
  forwardError: string | null
  forwarded: boolean
  pendingWarning?: string
}

const reportForwardErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
const isPromptReadinessTimeoutError = (error: unknown) =>
  error instanceof PromptReadinessTimeoutError

const buildPendingWarning = (workerName: string, pendingTaskCount: number, action: string) =>
  pendingTaskCount > 0
    ? `Hive recorded the ${action}, but ${workerName} still has ${pendingTaskCount} open dispatch${pendingTaskCount === 1 ? '' : 'es'}. ` +
      'A worker stays working until every dispatch is closed with `team report --dispatch <id>` or `team cancel --dispatch <id>`.'
    : undefined

export const createTeamOperations = ({
  agentRuntime,
  createDispatch,
  deleteDispatch,
  deleteMessage,
  findOpenDispatch,
  findOpenDispatchById,
  listOpenWorkspaceDispatches,
  insertMessage,
  markDispatchCancelled,
  markDispatchReportedByWorker,
  claimQueuedDispatch,
  reparkClaimedDispatch,
  reportOutbox,
  notifyWebhook,
  runDataMutation,
  isRuntimeClosing,
  workflowDispatchAwaiter,
  workspaceStore,
  dismissEphemeralWorker,
  recordProtocolEvent,
  markDispatchDelivered,
  recordReportPayloadBytes,
  requiredSeenSeq,
  drainDispatchMessages,
  getFlags,
}: TeamOperationsInput) => {
  const flags = () => getFlags?.() ?? FEATURE_FLAGS_ALL_OFF
  const runMutation = runDataMutation ?? ((mutation: () => void) => mutation())
  const runtimeClosing = () => isRuntimeClosing?.() === true
  const settleCancelledDelegations = (records: DispatchRecord[]) => {
    for (const record of records) {
      if (record.fromAgentId) drainDispatchMessages?.(record.workspaceId, record.fromAgentId)
      if (!workspaceStore.hasAgent(record.workspaceId, record.toAgentId)) continue
      workspaceStore.markTaskCancelled(record.workspaceId, record.toAgentId)
      const member = workspaceStore.getWorker(record.workspaceId, record.toAgentId)
      dismissEphemeralWhenIdle(record.workspaceId, member.id, member.pendingTaskCount)
      if (record.workflowRunId)
        workflowDispatchAwaiter.notifyCancel(record.id, record.reportText ?? 'Cancelled')
      void Promise.resolve()
        .then(() => {
          if (runtimeClosing()) return
          return agentRuntime.writeCancelPrompt(
            record.workspaceId,
            record.toAgentId,
            record.id,
            record.reportText ?? 'Parent responsibility cancelled',
            { requireActiveRun: true }
          )
        })
        .catch((error) => console.error('[hive] delegated cancellation delivery failed', error))
    }
  }
  const recordDispatchDelivery = (dispatchId: string, { payloadBytes, write }: SendPromptWrite) => {
    if (!markDispatchDelivered) return
    // Stamp delivery when the PTY write actually completes, not when it is
    // queued: the prompt-readiness wait in between is the injection latency
    // this metric exists to expose. Write failures are handled by the caller.
    void write.then(
      (written) => {
        if (!written || runtimeClosing()) return
        try {
          markDispatchDelivered({
            deliveredAt: Date.now(),
            dispatchId,
            dispatchPayloadBytes: payloadBytes,
          })
        } catch (error) {
          console.error('[hive] swallowed:collaborationMetrics.dispatchWrite', error)
        }
      },
      () => {}
    )
  }
  const dismissEphemeralWhenIdle = (
    workspaceId: string,
    workerId: string,
    remainingPendingTaskCount: number
  ) => {
    if (!dismissEphemeralWorker || remainingPendingTaskCount !== 0) return
    const worker = workspaceStore.listWorkers(workspaceId).find((entry) => entry.id === workerId)
    if (!worker || worker.ephemeral !== true || worker.spawnedBy !== 'orchestrator') return
    queueMicrotask(() => {
      if (runtimeClosing()) return
      try {
        dismissEphemeralWorker(workspaceId, workerId)
      } catch (error) {
        console.error('[hive] swallowed:ephemeralDismiss', error)
      }
    })
  }
  const recordReportBytes = (dispatchId: string, payload: string) => {
    if (!recordReportPayloadBytes) return
    try {
      recordReportPayloadBytes(dispatchId, utf8ByteLength(payload))
    } catch (error) {
      console.error('[hive] swallowed:collaborationMetrics.reportPayload', error)
    }
  }
  const drainingReportOutboxIds = new Set<number>()
  // Best-effort redelivery of reports a prior orchestrator outage stranded.
  // Called when a fresh report confirms the orchestrator is reachable and
  // when the orchestrator polls `team list` (its natural post-restart wakeup).
  // An entry is marked delivered only after its PTY write actually resolves,
  // so a still-down orchestrator just leaves the backlog pending.
  const drainReportOutbox = (
    workspaceId: string,
    targetAgentId = `${workspaceId}:orchestrator`
  ) => {
    if (runtimeClosing()) return { attempted: 0, firstSyncError: null as string | null }
    if (!agentRuntime.getActiveRunByAgentId(workspaceId, targetAgentId)) {
      return { attempted: 0, firstSyncError: null as string | null }
    }
    const pending = reportOutbox.listPending(workspaceId, targetAgentId)
    const pendingCount = pending.length
    const oldestEntry = pending[0]
    const oldestPendingWaitMs = oldestEntry ? Date.now() - oldestEntry.createdAt : 0
    let attempted = 0
    let firstSyncError: string | null = null
    for (const entry of pending) {
      if (drainingReportOutboxIds.has(entry.id)) continue
      drainingReportOutboxIds.add(entry.id)
      attempted += 1
      try {
        void agentRuntime
          .deliverSystemMessageToAgent(workspaceId, targetAgentId, entry.payload, {
            requireActiveRun: true,
          })
          .then(() => {
            if (!runtimeClosing()) reportOutbox.markDelivered(entry.id)
          })
          .catch((error) => {
            if (runtimeClosing()) return
            console.error('[hive] swallowed:teamReport.outboxDrain', {
              workspaceId,
              targetAgentId,
              pendingCount,
              oldestPendingWaitMs,
              error: reportForwardErrorMessage(error),
            })
          })
          .finally(() => {
            drainingReportOutboxIds.delete(entry.id)
          })
      } catch (error) {
        drainingReportOutboxIds.delete(entry.id)
        firstSyncError ??= reportForwardErrorMessage(error)
        if (!runtimeClosing()) {
          console.error('[hive] swallowed:teamReport.outboxDrain', {
            workspaceId,
            targetAgentId,
            pendingCount,
            oldestPendingWaitMs,
            error: reportForwardErrorMessage(error),
          })
        }
      }
    }
    return { attempted, firstSyncError }
  }
  const ensureWorkerRun = async (workspaceId: string, workerId: string, hivePort: string) => {
    const activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
    if (activeRun) {
      return activeRun
    }

    const config = agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
    if (!config) {
      throw new ConflictError('No worker launch config available')
    }

    workspaceStore.markAgentStarted(workspaceId, workerId)
    try {
      const run = await agentRuntime.startAgent(
        workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        workerId,
        { hivePort }
      )
      if (run.status === 'error') {
        workspaceStore.markAgentStopped(workspaceId, workerId)
        throw new ConflictError(`${config.command} failed to start`)
      }
      return run
    } catch (error) {
      workspaceStore.markAgentStopped(workspaceId, workerId)
      throw error
    }
  }

  const cancelUndeliveredDispatch = (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    reason: string,
    workflowRunId?: string,
    /** Non-workflow issuer to notify — without this the orchestrator already
     *  holds an ok:true for a dispatch that silently died (audit #34). */
    notifyAgentId?: string
  ) => {
    const cancelled = markDispatchCancelled({ dispatchId, reason, workspaceId })
    if (!cancelled) return
    settleCancelledDelegations(cancelled.cancelledDescendants ?? [])
    if (cancelled.delegatedFromId && cancelled.fromAgentId)
      drainDispatchMessages?.(workspaceId, cancelled.fromAgentId)
    try {
      workspaceStore.markTaskCancelled(workspaceId, workerId)
    } catch (error) {
      console.error('[hive] swallowed:teamDispatch.markTaskCancelled', error)
    }
    if (workflowRunId !== undefined) {
      workflowDispatchAwaiter.notifyCancel(dispatchId, reason)
    }
    if (notifyAgentId !== undefined && !cancelled.delegatedFromId) {
      notifyIssuerDurably(
        workspaceId,
        notifyAgentId,
        dispatchId,
        `Dispatch ${dispatchId} to @${workerNameOrId(workspaceId, workerId)} was CANCELLED: delivery failed (${reason}). ` +
          'The member likely exited before receiving it — re-send after the member is started, or dispatch to another member.'
      )
    }
  }

  const workerNameOrId = (workspaceId: string, workerId: string): string => {
    try {
      return workspaceStore.getWorker(workspaceId, workerId).name
    } catch {
      // Worker row already gone (e.g. dismissed) — fall back to the id.
      return workerId
    }
  }

  const buildIssuerSystemReminderPayload = (text: string) =>
    `<hive-system-reminder>\n${escapeHiveEnvelopeText(text)}\n</hive-system-reminder>\n`

  /** Issuer notification that survives the issuer being down: try the live
   *  PTY first; if the issuer has no active run (or the write rejects), park
   *  the notice in the report outbox — it drains on the issuer's next
   *  `team list` / start, the same redelivery path worker reports use.
   *  (A fire-and-forget writeSystemMessageToAgent silently no-ops without an
   *  active run, which is exactly when failures cluster — post-restart.) */
  const notifyIssuerDurably = (
    workspaceId: string,
    issuerAgentId: string,
    dispatchId: string,
    text: string
  ) => {
    const payload = buildIssuerSystemReminderPayload(text)
    const park = () => {
      try {
        reportOutbox.enqueue({
          workspaceId,
          targetAgentId: issuerAgentId,
          dispatchId,
          payload,
        })
      } catch (error) {
        console.error('[hive] swallowed:teamDispatch.notifyOutbox', error)
      }
    }
    try {
      agentRuntime
        .deliverSystemMessageToAgent(workspaceId, issuerAgentId, payload, {
          requireActiveRun: true,
        })
        .catch(park)
    } catch {
      park()
    }
  }

  /** Called inside the worker-delete transaction after stale pending outbox rows
   *  for the doomed dispatches are removed, but before dispatch rows are
   *  deleted. Open non-workflow dispatches get a durable issuer notice, avoiding
   *  a third silent outcome next to delivered/cancelled. */
  const notifyIssuersOfDroppedDispatches = (
    workspaceId: string,
    workerId: string,
    reason: string
  ): string[] => {
    const open = listOpenWorkspaceDispatches(workspaceId).filter(
      (item) =>
        item.toAgentId === workerId &&
        item.workflowRunId === null &&
        item.fromAgentId !== null &&
        item.fromAgentId !== getWorkflowAgentId(workspaceId)
    )
    const workerName = workerNameOrId(workspaceId, workerId)
    const targetAgentIds = new Set<string>()
    for (const item of open) {
      if (!item.fromAgentId) continue
      if (item.delegatedFromId) continue // The ledger emits its durable parent input.
      targetAgentIds.add(item.fromAgentId)
      reportOutbox.enqueue({
        workspaceId,
        targetAgentId: item.fromAgentId,
        dispatchId: item.id,
        payload: buildIssuerSystemReminderPayload(
          `Dispatch ${item.id} to @${workerName} was DROPPED: ${reason}. ` +
            'It will not run and cannot be reported — re-dispatch the task to another worker if it still matters.'
        ),
      })
    }
    return [...targetAgentIds]
  }

  /** #33: deliver dispatches parked while their worker was stopped. Called on
   *  worker run start (lifecycle) and after dispatchTask auto-starts a worker.
   *  `claimQueuedDispatch` makes each delivery single-shot under races (UI
   *  start vs auto-start send); failures compensate via
   *  cancelUndeliveredDispatch and notify the issuer. Workflow dispatches are
   *  excluded — the runner owns their lifecycle and its awaiters must not see
   *  a late delivery after the run already ended. */
  const replayQueuedDispatches = (
    workspaceId: string,
    workerId: string,
    options: { beforeSequence?: number; createdBeforeMs?: number; excludeDispatchId?: string } = {}
  ) => {
    if (!agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return
    const inReplayScope = (item: DispatchRecord) =>
      item.toAgentId === workerId &&
      item.workflowRunId === null &&
      item.fromAgentId !== getWorkflowAgentId(workspaceId) &&
      (options.createdBeforeMs === undefined || item.createdAt < options.createdBeforeMs) &&
      (options.beforeSequence === undefined ||
        (item.sequence !== null && item.sequence < options.beforeSequence)) &&
      item.id !== options.excludeDispatchId
    // Worker start passes createdBeforeMs. Re-park submitted rows whose PTY
    // write never completed so the queued replay below can deliver them.
    // Live send-path replay omits createdBeforeMs and must not touch in-flight claims.
    if (options.createdBeforeMs !== undefined) {
      for (const item of listOpenWorkspaceDispatches(workspaceId)) {
        if (item.status !== 'submitted' || item.deliveredAt !== null || !inReplayScope(item)) {
          continue
        }
        try {
          reparkClaimedDispatch(item.id)
        } catch (reparkError) {
          console.error('[hive] swallowed:teamReplay.reparkSubmitted', reparkError)
        }
      }
    }
    const queued = listOpenWorkspaceDispatches(workspaceId).filter(
      (item) => item.status === 'queued' && inReplayScope(item)
    )
    if (queued.length === 0) return
    let worker: ReturnType<typeof workspaceStore.getWorker>
    try {
      worker = workspaceStore.getWorker(workspaceId, workerId)
    } catch {
      return
    }
    /* A replay write only fails when the fresh run is already dead
       (PtyInactive) — nothing reached a live CLI, so the dispatch goes BACK
       to parked for the next start instead of being cancelled: one bad start
       must not destroy parked work. If the row is no longer 'submitted'
       (reported/cancelled meanwhile), the repark loses and we leave it be. */
    const failDispatch = (item: DispatchRecord, error: unknown) => {
      if (runtimeClosing()) return
      if (isPromptReadinessTimeoutError(error)) {
        try {
          cancelUndeliveredDispatch(
            workspaceId,
            workerId,
            item.id,
            reportForwardErrorMessage(error),
            item.workflowRunId ?? undefined,
            item.fromAgentId ?? undefined
          )
        } catch (cancelError) {
          console.error('[hive] swallowed:teamReplay.cancelUndelivered', cancelError)
        }
        console.error('[hive] swallowed:teamReplay.writePrompt', error)
        return
      }
      try {
        if (!reparkClaimedDispatch(item.id)) {
          console.error('[hive] swallowed:teamReplay.reparkLost', item.id)
        }
      } catch (reparkError) {
        console.error('[hive] swallowed:teamReplay.repark', reparkError)
      }
      console.error('[hive] swallowed:teamReplay.writePrompt', error)
    }
    for (const item of queued) {
      if (!claimQueuedDispatch(item.id)) continue
      let senderName = 'Orchestrator'
      if (item.fromAgentId) {
        try {
          senderName = workspaceStore.getAgent(workspaceId, item.fromAgentId).name
        } catch {
          // Issuer gone; the default label is still actionable for the worker.
        }
      }
      try {
        const writePrompt = agentRuntime.writeSendPrompt(
          workspaceId,
          workerId,
          item.id,
          senderName,
          worker.description,
          item.text,
          requiredSeenSeq?.(item.id, workerId) ?? 0,
          {
            beforeWrite: () => findOpenDispatchById(workspaceId, item.id)?.status === 'submitted',
          }
        )
        recordDispatchDelivery(item.id, writePrompt)
        void writePrompt.write.catch((error) => failDispatch(item, error))
      } catch (error) {
        failDispatch(item, error)
      }
    }
  }

  const dispatchTask = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const fromAgentId = input.fromAgentId
    const sender = fromAgentId ? workspaceStore.getAgent(workspaceId, fromAgentId) : undefined
    const worker = workspaceStore.getWorker(workspaceId, workerId)
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)
    const messageHandle = insertMessage(message)
    let dispatch: DispatchRecord | undefined
    let pendingMarked = false

    try {
      const dispatchInput: {
        delegatedFromId?: string
        fromAgentId?: string
        label?: string
        relatedToDispatchId?: string
        phase?: string
        stepIndex?: number
        text: string
        toAgentId: string
        workflowRunId?: string
        workspaceId: string
      } = {
        text,
        toAgentId: workerId,
        workspaceId,
      }
      if (input.relatedToDispatchId !== undefined) {
        if (sender?.role !== 'orchestrator')
          throw new ConflictError('Only the orchestrator may relate responsibilities')
        dispatchInput.relatedToDispatchId = input.relatedToDispatchId
      }
      if (input.delegatedFromId !== undefined) dispatchInput.delegatedFromId = input.delegatedFromId
      if (fromAgentId) dispatchInput.fromAgentId = fromAgentId
      if (input.workflowRunId !== undefined) dispatchInput.workflowRunId = input.workflowRunId
      if (input.stepIndex !== undefined) dispatchInput.stepIndex = input.stepIndex
      if (input.phase !== undefined) dispatchInput.phase = input.phase
      if (input.label !== undefined) dispatchInput.label = input.label
      dispatch = createDispatch(dispatchInput)
      recordProtocolEvent?.('send')
      const dispatchId = dispatch.id

      if (fromAgentId && sender) {
        const shouldAutoStartWorker = input.autoStartWorker !== false
        let activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
        if (!activeRun && shouldAutoStartWorker) {
          activeRun = await ensureWorkerRun(workspaceId, workerId, input.hivePort ?? '')
          // Revalidate before accepting the task: a worker deleted while the
          // PTY was starting must not leave an accepted-but-undeliverable row.
          workspaceStore.getWorker(workspaceId, workerId)
          // Cancel can win during the await. Do not 202 a stale queued object.
          if (!findOpenDispatchById(workspaceId, dispatchId)) {
            throw new ConflictError(`Dispatch ${dispatchId} is no longer open`)
          }
        }
        if (!shouldAutoStartWorker && !agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
          workspaceStore.markTaskDispatched(workspaceId, workerId)
          pendingMarked = true
          // Parked for a stopped worker: replayQueuedDispatches delivers it on
          // the next worker start. Tag the record so the route/CLI can say so.
          return Object.assign(dispatch, { queuedForStoppedWorker: true as const })
        }
        const isWorkflowDispatch =
          input.workflowRunId !== undefined || input.fromAgentId === getWorkflowAgentId(workspaceId)
        const writeClaimedDispatch = (currentWorker: typeof worker) => {
          try {
            const writePrompt = agentRuntime.writeSendPrompt(
              workspaceId,
              workerId,
              dispatchId,
              sender.name,
              currentWorker.description,
              text,
              requiredSeenSeq?.(dispatchId, workerId) ?? 0,
              {
                beforeWrite: () =>
                  findOpenDispatchById(workspaceId, dispatchId)?.status === 'submitted',
              }
            )
            recordDispatchDelivery(dispatchId, writePrompt)
            void writePrompt.write.catch((error) => {
              if (runtimeClosing()) return
              // `team send` is intentionally asynchronous (§3.3). A worker that
              // exits during paste-submit did not receive actionable work, so
              // close the open dispatch instead of leaving a fake pending task.
              try {
                cancelUndeliveredDispatch(
                  workspaceId,
                  workerId,
                  dispatchId,
                  reportForwardErrorMessage(error),
                  input.workflowRunId,
                  isWorkflowDispatch ? undefined : fromAgentId
                )
              } catch (cancelError) {
                if (!isWorkflowDispatch)
                  console.error('[hive] swallowed:teamDispatch.cancelUndelivered', cancelError)
              }
              if (!isWorkflowDispatch)
                console.error('[hive] swallowed:teamDispatch.writePrompt', error)
            })
          } catch (error) {
            try {
              cancelUndeliveredDispatch(
                workspaceId,
                workerId,
                dispatchId,
                reportForwardErrorMessage(error),
                input.workflowRunId,
                isWorkflowDispatch ? undefined : fromAgentId
              )
            } catch (cancelError) {
              if (!isWorkflowDispatch)
                console.error('[hive] swallowed:teamDispatch.cancelUndelivered', cancelError)
            }
            if (!isWorkflowDispatch)
              console.error('[hive] swallowed:teamDispatch.writePrompt', error)
          }
        }
        const claimAndWriteDispatch = () => {
          const currentWorker = workspaceStore.getWorker(workspaceId, workerId)
          const claimed = claimQueuedDispatch(dispatchId)
          if (claimed) writeClaimedDispatch(currentWorker)
        }
        // A PTY can flip from starting -> running on the first stdout chunk
        // before Hermes/OpenCode is actually ready for our startup injection.
        // The post-start barrier, not the coarse run status, is the source of
        // truth for when the first task may be pasted.
        const deferUntilPostStartReady = activeRun?.postStartInputReady
        if (deferUntilPostStartReady) {
          workspaceStore.markTaskDispatched(workspaceId, workerId)
          pendingMarked = true
          const cancelDeferredDispatch = (error: unknown) => {
            if (runtimeClosing()) return
            try {
              cancelUndeliveredDispatch(
                workspaceId,
                workerId,
                dispatchId,
                reportForwardErrorMessage(error),
                input.workflowRunId,
                isWorkflowDispatch ? undefined : fromAgentId
              )
            } catch (cancelError) {
              if (!isWorkflowDispatch)
                console.error('[hive] swallowed:teamDispatch.cancelUndelivered', cancelError)
            }
            if (!isWorkflowDispatch)
              console.error('[hive] swallowed:teamDispatch.deferredWrite', error)
          }
          void deferUntilPostStartReady
            .then(() => {
              if (runtimeClosing()) return
              const current = listOpenWorkspaceDispatches(workspaceId).find(
                (item) => item.id === dispatchId
              )
              if (!current || current.status !== 'queued') return
              // Deliver older parked work first, but do not let later sends
              // jump ahead of this dispatch while a starting PTY settles.
              const replayOptions: { beforeSequence?: number; excludeDispatchId: string } = {
                excludeDispatchId: dispatchId,
              }
              if (current.sequence !== null) replayOptions.beforeSequence = current.sequence
              replayQueuedDispatches(workspaceId, workerId, replayOptions)
              claimAndWriteDispatch()
            })
            .catch(cancelDeferredDispatch)
          return dispatch
        }
        // Revalidate the worker before claiming: it may have been deleted
        // while ensureWorkerRun was awaited (R2 hardening) — a vanished worker
        // must not leave a claimed-but-undeliverable dispatch behind.
        workspaceStore.getWorker(workspaceId, workerId)
        // Claim (queued → submitted) instead of a blind mark: a UI-initiated
        // start can replay-deliver this dispatch while ensureWorkerRun above
        // was awaited — losing the claim means delivery is already owned.
        const claimed = claimQueuedDispatch(dispatchId)
        workspaceStore.markTaskDispatched(workspaceId, workerId)
        pendingMarked = true
        if (claimed) writeClaimedDispatch(worker)
      } else {
        workspaceStore.markTaskDispatched(workspaceId, workerId)
        pendingMarked = true
      }

      return dispatch
    } catch (error) {
      if (pendingMarked) {
        try {
          workspaceStore.markTaskCancelled(workspaceId, workerId)
        } catch {
          // Best-effort compensation for the in-memory pending count; the
          // durable send message is deleted below.
        }
      }
      const stillOwnedQueued =
        dispatch !== undefined &&
        findOpenDispatchById(workspaceId, dispatch.id)?.status === 'queued'
      if (dispatch && stillOwnedQueued) deleteDispatch(dispatch.id)
      if (stillOwnedQueued || dispatch === undefined) deleteMessage(messageHandle)
      throw error
    }
  }

  return {
    settleCancelledDelegations,
    async cancelTask(workspaceId: string, dispatchId: string, input: CancelTaskInput) {
      const actor = workspaceStore.getAgent(workspaceId, input.fromAgentId)
      const openDispatch = findOpenDispatchById(workspaceId, dispatchId)
      if (!openDispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      if (
        actor.role !== 'orchestrator' &&
        (!openDispatch.delegatedFromId || openDispatch.fromAgentId !== actor.id)
      )
        throw new ForbiddenError('Members may cancel only tasks they directly delegated')
      const dispatch = markDispatchCancelled({
        dispatchId,
        reason: input.reason,
        workspaceId,
      })
      if (!dispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      settleCancelledDelegations(dispatch.cancelledDescendants ?? [])
      if (dispatch.delegatedFromId && dispatch.fromAgentId)
        drainDispatchMessages?.(workspaceId, dispatch.fromAgentId)
      // The ledger row is already cancelled; a worker dismissed in the
      // meantime has no pending counter left to decrement.
      if (
        workspaceStore.listWorkers(workspaceId).some((entry) => entry.id === dispatch.toAgentId)
      ) {
        workspaceStore.markTaskCancelled(workspaceId, dispatch.toAgentId)
      }
      recordProtocolEvent?.('cancel')
      // A workflow-owned dispatch cancelled from outside the runner (e.g. an
      // orchestrator that got hold of the id) must still resolve the runner's
      // awaiter — otherwise the run wedges until its step timeout.
      if (dispatch.workflowRunId !== null) {
        workflowDispatchAwaiter.notifyCancel(dispatch.id, input.reason)
      }
      let forwardError: string | null = null
      let forwarded = false
      try {
        await agentRuntime.writeCancelPrompt(
          workspaceId,
          dispatch.toAgentId,
          dispatch.id,
          input.reason,
          {
            requireActiveRun: true,
          }
        )
        forwarded = true
      } catch (error) {
        forwardError = reportForwardErrorMessage(error)
        console.error('[hive] swallowed:teamCancel.forward', error)
      }
      // The worker may have been dismissed while the cancel prompt was in
      // flight; the ledger row is already cancelled, so never 500 here.
      const target = workspaceStore
        .listWorkers(workspaceId)
        .find((entry) => entry.id === dispatch.toAgentId)
      if (target) dismissEphemeralWhenIdle(workspaceId, target.id, target.pendingTaskCount)
      return { dispatch, forwardError, forwarded }
    },
    dispatchTask,
    drainReportOutbox,
    replayQueuedDispatches,
    notifyIssuersOfDroppedDispatches,
    async dispatchTaskByWorkerName(
      workspaceId: string,
      workerName: string,
      text: string,
      input: DispatchTaskInput = {}
    ): Promise<DispatchRecord & { restartedWorker: boolean }> {
      /* Build the roster once so a missing-name path can surface it without
         a second store call. We deliberately don't go through
         `getWorkerByName` because its underlying record helper throws a
         bare Error — that bubbles as HTTP 500 and looks like a server bug
         to the orchestrator, instead of the self-healing 409 we want. */
      const roster = workspaceStore.listWorkers(workspaceId)
      const worker = roster.find((entry) => entry.name === workerName)
      if (!worker) {
        throw new ConflictError(formatUnknownWorkerError(workerName, roster))
      }
      /* Capture the active-run state *before* dispatchTask runs. Internal
         workflow calls and orchestrator-owned `team spawn` follow-up sends may
         auto-start a stopped worker; user-managed stopped workers remain
         stopped with a queued dispatch until the user restarts them. */
      const restartedWorker =
        input.fromAgentId !== undefined &&
        input.autoStartWorker !== false &&
        !agentRuntime.getActiveRunByAgentId(workspaceId, worker.id)
      const dispatch = await dispatchTask(workspaceId, worker.id, text, input)
      return Object.assign(dispatch, { restartedWorker })
    },
    recordUserInput(workspaceId: string, orchestratorId: string, text: string) {
      workspaceStore.getAgent(workspaceId, orchestratorId)
      agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
    },
    async deliverUserInput(workspaceId: string, orchestratorId: string, text: string) {
      workspaceStore.getAgent(workspaceId, orchestratorId)
      const messageHandle = insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
      try {
        await agentRuntime.deliverUserInputToOrchestrator(workspaceId, text, {
          requireActiveRun: true,
        })
      } catch (error) {
        try {
          deleteMessage(messageHandle)
        } catch (deleteError) {
          console.error('[hive] swallowed:userInput.rollback', deleteError)
        }
        throw error
      }
    },
    statusTask(workspaceId: string, workerId: string, input: StatusTaskInput = {}) {
      const text = input.text ?? ''
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const messageHandle = insertMessage(
        createStatusMessage(workspaceId, workerId, text, artifacts)
      )
      recordProtocolEvent?.('status')
      try {
        let deliveryState: ReportDeliveryState | undefined
        let forwardError: string | null = null
        let forwarded = false
        if (input.requireActiveRun === true) {
          try {
            const delivery = agentRuntime.writeStatusPrompt(
              workspaceId,
              worker.name,
              workerId,
              text,
              artifacts,
              {
                requireActiveRun: input.requireActiveRun,
              }
            )
            deliveryState = 'delivering'
            forwarded = false
            forwardError = null
            void delivery.catch((error) => {
              if (runtimeClosing()) return
              console.error('[hive] swallowed:teamStatus.forward', {
                workspaceId,
                workerId,
                error: reportForwardErrorMessage(error),
              })
            })
          } catch (error) {
            deliveryState = 'failed'
            forwardError = reportForwardErrorMessage(error)
            console.error('[hive] swallowed:teamStatus.forward', {
              workspaceId,
              workerId,
              error: reportForwardErrorMessage(error),
            })
          }
        }
        const pendingWarning = buildPendingWarning(
          worker.name,
          worker.pendingTaskCount,
          'status update'
        )
        return {
          ...(deliveryState ? { deliveryState } : {}),
          dispatch: null,
          forwardError,
          forwarded,
          ...(pendingWarning ? { pendingWarning } : {}),
        }
      } catch (error) {
        deleteMessage(messageHandle)
        throw error
      }
    },
    reportTask(workspaceId: string, workerId: string, input: ReportTaskInput = {}) {
      const text = input.text ?? ''
      const status = input.status
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const openDispatch = findOpenDispatch(workspaceId, workerId, input.dispatchId)
      if (!openDispatch) {
        throw new ConflictError(
          formatNoOpenDispatchError(
            worker.name,
            input.dispatchId,
            listOpenWorkspaceDispatches(workspaceId).filter((item) => item.toAgentId === workerId)
          )
        )
      }
      let messageHandle: MessageLogHandle | undefined
      let dispatch: DispatchRecord | undefined
      let reportQueuedBeforeCommit = false
      const orchestratorId = `${workspaceId}:orchestrator`
      const payload = buildOrchestratorReportPayload(
        worker.name,
        text,
        artifacts,
        flags(),
        openDispatch.id
      )
      const workflowDispatch = openDispatch.fromAgentId === getWorkflowAgentId(workspaceId)
      const shouldQueueForOrchestrator =
        input.requireActiveRun === true && !workflowDispatch && !openDispatch.delegatedFromId
      if (
        shouldQueueForOrchestrator &&
        agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)
      ) {
        drainReportOutbox(workspaceId)
      }
      try {
        runMutation(() => {
          messageHandle = insertMessage(
            createReportMessage(workspaceId, workerId, text, status, artifacts)
          )
          if (shouldQueueForOrchestrator) {
            reportOutbox.enqueue({
              workspaceId,
              targetAgentId: orchestratorId,
              dispatchId: openDispatch.id,
              payload,
            })
            reportQueuedBeforeCommit = true
          }
          const nextDispatch = markDispatchReportedByWorker({
            artifacts,
            ...(input.ackBatchId ? { ackBatchId: input.ackBatchId } : {}),
            ...(status ? { outcome: status } : {}),
            ...(input.seenSeq !== undefined ? { seenSeq: input.seenSeq } : {}),
            ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
            reportText: text,
            toAgentId: workerId,
            workspaceId,
          })
          if (!nextDispatch) {
            // Post-race recheck: the dispatch closed between the precheck and
            // the ledger write — re-query so the 409 lists what is still open.
            throw new ConflictError(
              formatNoOpenDispatchError(
                worker.name,
                input.dispatchId,
                listOpenWorkspaceDispatches(workspaceId).filter(
                  (item) => item.toAgentId === workerId
                )
              )
            )
          }
          dispatch = nextDispatch
          recordProtocolEvent?.('report')
          recordReportBytes(nextDispatch.id, payload)
        })
      } catch (error) {
        if (!runDataMutation) {
          if (reportQueuedBeforeCommit) {
            try {
              reportOutbox.deletePendingForDispatch(openDispatch.id)
            } catch (deleteOutboxError) {
              console.error('[hive] swallowed:teamReport.outboxRollback', deleteOutboxError)
            }
          }
          if (messageHandle) deleteMessage(messageHandle)
        }
        throw error
      }
      if (!dispatch) throw new Error('Report dispatch was not committed')
      const committedDispatch = dispatch
      workspaceStore.markTaskReported(workspaceId, workerId)
      const remainingPendingTaskCount = workspaceStore.getWorker(
        workspaceId,
        workerId
      ).pendingTaskCount
      let forwardError: string | null = null
      let forwarded = false
      let deliveryState: ReportDeliveryState | undefined
      const pendingWarning = buildPendingWarning(worker.name, remainingPendingTaskCount, 'report')
      if (committedDispatch.delegatedFromId && committedDispatch.fromAgentId) {
        drainDispatchMessages?.(workspaceId, committedDispatch.fromAgentId)
        dismissEphemeralWhenIdle(workspaceId, workerId, remainingPendingTaskCount)
        return {
          dispatch: committedDispatch,
          deliveryState: 'queued' as const,
          forwarded: false,
          forwardError: null,
          ...(pendingWarning ? { pendingWarning } : {}),
        }
      }

      // Workflow-sourced dispatches: the source is the in-process runner, not a
      // PTY. Resolve its awaiting Promise instead of injecting into orchestrator
      // stdin (which would do nothing — `__workflow__` has no PTY).
      if (committedDispatch.fromAgentId === getWorkflowAgentId(workspaceId)) {
        try {
          workflowDispatchAwaiter.notifyReport(committedDispatch.id, {
            artifacts,
            text,
            ...(status ? { status } : {}),
          })
          deliveryState = 'delivered'
          forwarded = true
        } catch (error) {
          deliveryState = 'failed'
          forwardError = reportForwardErrorMessage(error)
          console.error('[hive] swallowed:teamReport.workflowForward', error)
        }
        return {
          ...(deliveryState ? { deliveryState } : {}),
          dispatch: committedDispatch,
          forwardError,
          forwarded,
          ...(pendingWarning ? { pendingWarning } : {}),
        }
      }

      // Real worker reported (not a workflow-internal step) — fire the
      // outbound completion webhook. Best-effort; never blocks the report.
      notifyWebhook?.({
        type: 'report_received',
        workspaceId,
        agentId: workerId,
        agentName: worker.name,
        summary: text.slice(0, 280),
        at: Date.now(),
      })

      if (input.requireActiveRun === true) {
        if (agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)) {
          const drainResult = drainReportOutbox(workspaceId, orchestratorId)
          forwarded = false
          if (drainResult.firstSyncError) {
            deliveryState = reportQueuedBeforeCommit ? 'queued' : 'failed'
            forwardError = drainResult.firstSyncError
          } else if (reportQueuedBeforeCommit) {
            deliveryState = 'delivering'
            forwardError = null
          }
        } else {
          // Orchestrator is down. Queue the report instead of dropping it;
          // the CLI surfaces forwarded:false and the backlog drains on the
          // orchestrator's next `team list` after it restarts.
          deliveryState = reportQueuedBeforeCommit ? 'queued' : 'failed'
          forwardError = reportQueuedBeforeCommit
            ? 'Orchestrator is not running; report queued for delivery.'
            : 'Orchestrator is not running; report could not be queued for delivery.'
        }
      }

      // M11: if this worker was spawned with `team spawn --ephemeral`, the
      // report that closes its LAST open dispatch triggers auto-dismiss.
      // Gating on remainingPendingTaskCount === 0 keeps the one-shot
      // semantics for the normal single-dispatch case while not deleting
      // still-queued dispatches un-reported when the orchestrator stacked
      // several sends. `team cancel` closing the last dispatch takes the
      // same path (see cancelTask). Deferred via queueMicrotask so the
      // orchestrator's forward write lands BEFORE the worker's PTY is torn
      // down (otherwise the inject + dismiss race). Skipped for workflow
      // dispatches — workflow workers are managed by the runner's own
      // finally block.
      dismissEphemeralWhenIdle(workspaceId, workerId, remainingPendingTaskCount)
      return {
        ...(deliveryState ? { deliveryState } : {}),
        dispatch: committedDispatch,
        forwardError,
        forwarded,
        ...(pendingWarning ? { pendingWarning } : {}),
      }
    },
  }
}
