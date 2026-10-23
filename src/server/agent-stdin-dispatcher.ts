import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { formatRequiredSeenSeqAdvice } from './dispatch-message-payload.js'
import { FEATURE_FLAGS_ALL_OFF, type FeatureFlags } from './feature-flags.js'
import { escapeHiveEnvelopeAttribute, escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import { buildOrchestratorReminderTail, buildWorkerReminderTail } from './hive-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createImmediateInteractiveInputWriter } from './post-start-input-writer.js'
import {
  buildDispatchMemoryDigestSafely,
  logMemoryDigestInjection,
  rollbackMemoryDigestInjection,
  type TeamMemoryInjectionService,
} from './team-memory-injection.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
  memoryInjection?: TeamMemoryInjectionService
  /** Live flags retained for payload API compatibility. Optional; omitted → all off. */
  getFlags?: () => FeatureFlags
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  flags: FeatureFlags = FEATURE_FLAGS_ALL_OFF,
  dispatchId?: string
): string => {
  const dispatchAttribute = dispatchId
    ? ` dispatch="${escapeHiveEnvelopeAttribute(dispatchId)}"`
    : ''
  const lines: string[] = [
    `<hive-message kind="report" from="@${escapeHiveEnvelopeAttribute(workerName)}"${dispatchAttribute}>`,
    ...(dispatchId
      ? [
          '',
          `dispatch_id: ${escapeHiveEnvelopeText(dispatchId)}`,
          'If this dispatch_id report was already processed, treat this as a duplicate redelivery and ignore it.',
          '',
        ]
      : []),
    escapeHiveEnvelopeText(text),
  ]
  for (const artifact of artifacts) lines.push(`artifact: ${escapeHiveEnvelopeText(artifact)}`)
  lines.push('</hive-message>', '', buildOrchestratorReminderTail(flags), '')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  flags: FeatureFlags = FEATURE_FLAGS_ALL_OFF
): string => {
  const lines: string[] = [
    `<hive-message kind="status" from="@${escapeHiveEnvelopeAttribute(workerName)}">`,
    escapeHiveEnvelopeText(text),
  ]
  for (const artifact of artifacts) lines.push(`artifact: ${escapeHiveEnvelopeText(artifact)}`)
  lines.push('</hive-message>', '', buildOrchestratorReminderTail(flags), '')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (
  text: string,
  flags: FeatureFlags = FEATURE_FLAGS_ALL_OFF
): string => [text, '', buildOrchestratorReminderTail(flags), ''].join('\n')

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  _workerDescription: string,
  dispatchId: string,
  text: string,
  memoryDigest?: string | null,
  requiredSeenSeq = 0
): string =>
  [
    `<hive-message kind="dispatch" from="@${escapeHiveEnvelopeAttribute(fromAgentName)}">`,
    '',
    `dispatch_id: ${escapeHiveEnvelopeText(dispatchId)}`,
    'New responsibility. Preserve your startup role and assigned file ownership.',
    `required_seen_seq: ${requiredSeenSeq}`,
    // This is a submission requirement, not a claim that the dispatch envelope
    // includes the attached messages. A later append can still make it stale.
    ...(requiredSeenSeq > 0
      ? [
          'Attached inbound messages are not included in this task envelope; read the dispatch messages before reporting.',
        ]
      : []),
    formatRequiredSeenSeqAdvice(escapeHiveEnvelopeText(dispatchId), requiredSeenSeq),
    '',
    ...(memoryDigest ? [memoryDigest, ''] : []),
    'Task:',
    escapeHiveEnvelopeText(text),
    '</hive-message>',
    '',
    buildWorkerReminderTail(dispatchId),
    '',
  ].join('\n')

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `<hive-message kind="cancel" dispatch="${escapeHiveEnvelopeAttribute(dispatchId)}">`,
    '',
    'Stop working on this dispatch and do not call team report for it.',
    '',
    'Cancellation reason:',
    escapeHiveEnvelopeText(reason),
    '</hive-message>',
    '',
  ].join('\n')

export const utf8ByteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** A dispatch write plus the UTF-8 size of the envelope that went into the
 *  PTY — the collaboration-cost metric (#75) records both. */
export interface SendPromptWrite {
  payloadBytes: number
  /** False means ownership was lost before writing; no delivery may be recorded. */
  write: Promise<boolean>
}

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
  memoryInjection,
  getFlags,
}: AgentStdinDispatcherInput) => {
  const flags = () => getFlags?.() ?? FEATURE_FLAGS_ALL_OFF
  // Per-agent serial queue. Two writers to the SAME agent (UI + orchestrator,
  // or orchestrator + workflow runner) must not interleave their
  // bracketed-paste/submit sequences, or the CLI receives a corrupted payload.
  // Writes to DIFFERENT agents stay concurrent (one chain per agentId).
  type QueuedWrite = {
    reject: (error: unknown) => void
    resolve: () => void
    run: () => Promise<void>
  }
  const chains = new Map<string, { busy: boolean; queue: QueuedWrite[] }>()
  const getChain = (agentId: string) => {
    let chain = chains.get(agentId)
    if (!chain) {
      chain = { busy: false, queue: [] }
      chains.set(agentId, chain)
    }
    return chain
  }

  const resolveActiveRun = (workspaceId: string, agentId: string) =>
    registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })

  // Synchronously enforce requireActiveRun (so writeSendPrompt still throws in
  // the caller's stack when there is no live run), then return a thunk that
  // re-resolves the run at EXECUTION time and performs the actual write,
  // returning a promise that settles when the paste→submit sequence is done.
  const prepareWrite = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean; beforeWrite?: () => boolean }
  ): (() => Promise<void>) => {
    if (!resolveActiveRun(workspaceId, agentId)) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return () => Promise.resolve()
    }
    const writeWhenReady = (readyRunId?: string): Promise<void> => {
      const run = resolveActiveRun(workspaceId, agentId)
      if (!run) {
        if (input.requireActiveRun) {
          throw new PtyInactiveError(`No active run for agent: ${agentId}`)
        }
        return Promise.resolve()
      }
      if (run.postStartInputReady && !run.startupReadyAt && readyRunId !== run.runId) {
        return run.postStartInputReady.then(() => writeWhenReady(run.runId))
      }
      if (input.beforeWrite?.() === false) return Promise.resolve()
      try {
        const config = getLaunchConfig(workspaceId, agentId)
        if (agentManager && config) {
          return (
            createImmediateInteractiveInputWriter(
              agentManager,
              config.interactiveCommand ?? config.command
            )(run.runId, text).catch((error) => {
              throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
            }) ?? Promise.resolve()
          )
        }
        agentManager?.writeInput(run.runId, text)
        return Promise.resolve()
      } catch (error) {
        throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
      }
    }
    return () => writeWhenReady()
  }

  const settle = (agentId: string, promise: Promise<void>) =>
    promise.finally(() => {
      const chain = chains.get(agentId)
      if (!chain) return
      chain.busy = false
      drain(agentId)
    })

  const runQueuedWrite = (agentId: string, write: QueuedWrite) => {
    try {
      void settle(agentId, write.run()).then(write.resolve, write.reject)
    } catch (error) {
      write.reject(error)
      const chain = chains.get(agentId)
      if (chain) chain.busy = false
      drain(agentId)
    }
  }

  function drain(agentId: string) {
    const chain = chains.get(agentId)
    if (!chain) return
    if (chain.busy) return
    const next = chain.queue.shift()
    if (!next) {
      chains.delete(agentId)
      return
    }
    chain.busy = true
    runQueuedWrite(agentId, next)
  }

  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean; beforeWrite?: () => boolean } = {}
  ): Promise<void> => {
    const thunk = prepareWrite(workspaceId, agentId, text, input)
    const chain = getChain(agentId)
    if (chain.busy) {
      return new Promise<void>((resolve, reject) => {
        chain.queue.push({ reject, resolve, run: thunk })
      })
    }
    chain.busy = true
    try {
      return settle(agentId, thunk()) // uncontended: run now; immediate failures still throw
    } catch (error) {
      chain.busy = false
      drain(agentId)
      throw error
    }
  }

  const swallowQueuedFailure = (promise: Promise<void>) => {
    void promise.catch(() => {
      // Deferred prompt writes can fail if the PTY exits while queued. Calls
      // that require foreground error reporting use writeSendPrompt's promise.
    })
  }

  return {
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ): Promise<void> {
      const payload = buildOrchestratorStatusPayload(workerName, text, artifacts, flags())
      return writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, payload, input)
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string,
      requiredSeenSeq = 0,
      input: { beforeWrite?: () => boolean } = {}
    ): SendPromptWrite {
      if (!resolveActiveRun(workspaceId, workerId)) {
        throw new PtyInactiveError(`No active run for agent: ${workerId}`)
      }
      const memoryDigest = buildDispatchMemoryDigestSafely({
        memoryInjection,
        taskText: text,
        workerDescription,
        workspaceId,
      })
      const injectionIds = logMemoryDigestInjection({
        agentId: workerId,
        contextType: 'dispatch',
        dispatchId,
        memoryDigest,
        memoryInjection,
        workspaceId,
      })
      const rollback = () =>
        rollbackMemoryDigestInjection({
          injectionIds,
          memoryInjection,
        })
      const payload = buildWorkerDispatchPayload(
        fromAgentName,
        workerDescription,
        dispatchId,
        text,
        injectionIds ? memoryDigest?.text : null,
        requiredSeenSeq
      )
      try {
        let written = false
        const write = writeToActiveAgentRun(workspaceId, workerId, payload, {
          requireActiveRun: true,
          beforeWrite: () => {
            if (input.beforeWrite?.() === false) return false
            written = true
            return true
          },
        })
          .then(() => {
            if (!written) rollback()
            return written
          })
          .catch((error) => {
            rollback()
            throw error
          })
        return { payloadBytes: utf8ByteLength(payload), write }
      } catch (error) {
        rollback()
        throw error
      }
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ): Promise<void> {
      return writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason),
        input
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      swallowQueuedFailure(
        writeToActiveAgentRun(
          workspaceId,
          `${workspaceId}:orchestrator`,
          buildOrchestratorUserInputPayload(text, flags())
        )
      )
    },
    deliverUserInputToOrchestrator(
      workspaceId: string,
      text: string,
      input: { requireActiveRun?: boolean } = {}
    ): Promise<void> {
      return writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorUserInputPayload(text, flags()),
        input
      )
    },
    /** Generic: deliver an opaque text block to a specific agent's PTY.
     *  Used by the workflow runner to notify the triggering orchestrator
     *  when a run finishes (mirrors Claude Code's <task-notification>). */
    writeSystemMessageToAgent(workspaceId: string, agentId: string, text: string) {
      swallowQueuedFailure(writeToActiveAgentRun(workspaceId, agentId, text))
    },
    /** Awaitable opaque delivery — used to drain the report outbox so an entry
     *  is marked delivered only after the PTY write actually resolves. */
    deliverSystemMessageToAgent(
      workspaceId: string,
      agentId: string,
      text: string,
      input: { requireActiveRun?: boolean; beforeWrite?: () => boolean } = {}
    ): Promise<void> {
      return writeToActiveAgentRun(workspaceId, agentId, text, input)
    },
  }
}
