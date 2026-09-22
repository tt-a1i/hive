import { CONTROLLER_GUIDANCE } from '../shared/controller-guidance.js'
import type { ControllerStatus } from '../shared/types.js'
import {
  type ControllerActionInput,
  controllerString,
  executeControllerMutation,
  validateControllerAction,
} from './controller-actions.js'
import { createControllerNotifier } from './controller-notifier.js'
import { createControllerStore } from './controller-store.js'
import {
  serializeDispatchMessage,
  serializeDispatchMessagesResult,
} from './dispatch-message-serializer.js'
import { ConflictError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'

export type { ControllerStatus } from '../shared/types.js'
export interface ControllerMethods {
  getControllerStatus: (workspaceId: string) => ControllerStatus
  requestController: (workspaceId: string, threadId: string) => ControllerStatus
  confirmController: (workspaceId: string, requestId: string) => Promise<ControllerStatus>
  disconnectController: (workspaceId: string) => ControllerStatus
  controllerAction: (
    input: ControllerActionInput,
    threadId: string,
    hivePort: string
  ) => Promise<unknown>
}
export const createRuntimeStoreController = (
  services: RuntimeStoreServices,
  getStore: () => RuntimeStore
) => {
  let closing = false
  const isClosing = () => closing || services.isRuntimeClosing()
  const persistence = createControllerStore(services.db)
  const notifier = createControllerNotifier(services.db)
  const requireExternal = (workspaceId: string) => {
    if (
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode !==
      'codex_app'
    )
      throw new ConflictError('Create a Codex App workspace to connect an external controller')
  }
  const timer = setInterval(() => {
    if (isClosing()) return
    try {
      notifier.notify()
    } catch (error) {
      console.error('[hive] controller notification scan failed', error)
    }
  }, 1000)
  timer.unref()
  const isBusy = (workspaceId: string) =>
    notifier.isConnecting(workspaceId) ||
    services.dispatchLedgerStore.listOpenWorkspaceDispatches(workspaceId).length > 0 ||
    persistence.pendingCount(workspaceId) > 0 ||
    persistence.hasBusyOperation(workspaceId) ||
    persistence.hasSendingNotification(workspaceId) ||
    services.db
      .prepare(`SELECT 1 FROM dispatch_message_outbox o JOIN dispatch_messages m ON m.id = o.message_id
      WHERE m.workspace_id = ? AND (o.state = 'delivering' OR (o.state = 'queued'
        AND NOT (m.kind = 'question' AND m.controller_thread_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM dispatches d WHERE d.id = m.dispatch_id AND d.status = 'reported'
        )))) LIMIT 1`)
      .get(workspaceId) !== undefined
  const status = (workspaceId: string): ControllerStatus => {
    const mode =
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode ??
      'internal'
    if (mode === 'internal')
      return {
        mode,
        thread_id: null,
        pending_request: null,
        pending_reports: 0,
        notification_error: null,
        can_disconnect: false,
      }
    const row = persistence.get(workspaceId)
    return {
      mode,
      thread_id: row.thread_id,
      pending_request:
        row.request_id && row.request_thread_id
          ? { id: row.request_id, thread_id: row.request_thread_id }
          : null,
      pending_reports: persistence.pendingCount(workspaceId),
      notification_error: row.connection_error ?? persistence.notificationError(workspaceId),
      can_disconnect: Boolean(row.thread_id || row.request_id) && !isBusy(workspaceId),
    }
  }
  const methods: ControllerMethods = {
    getControllerStatus: status,
    requestController(workspaceId, threadId) {
      requireExternal(workspaceId)
      persistence.request(workspaceId, threadId)
      return status(workspaceId)
    },
    async confirmController(workspaceId, requestId) {
      requireExternal(workspaceId)
      if (isClosing()) throw new ConflictError('Hive runtime is closing')
      try {
        await notifier.requireCapability()
      } catch (error) {
        if (isClosing()) throw new ConflictError('Hive runtime is closing')
        const message = error instanceof Error ? error.message : String(error)
        persistence.setConnectionError(workspaceId, requestId, message)
        throw new ConflictError(message)
      }
      if (isClosing()) throw new ConflictError('Hive runtime is closing')
      if (isBusy(workspaceId))
        throw new ConflictError(
          'Finish pending work and receive all reports before connecting a controller'
        )
      const threadId = persistence.confirm(workspaceId, requestId)
      await notifier.notifyConnected(workspaceId, threadId)
      if (isClosing()) throw new ConflictError('Hive runtime is closing')
      return status(workspaceId)
    },
    disconnectController(workspaceId) {
      requireExternal(workspaceId)
      services.db.transaction(() => {
        if (isBusy(workspaceId))
          throw new ConflictError(
            'Finish pending work and receive all reports before disconnecting'
          )
        persistence.disconnect(workspaceId)
      })()
      return status(workspaceId)
    },
    async controllerAction(input, threadId, hivePort) {
      validateControllerAction(input)
      requireExternal(input.workspace_id)
      persistence.requireThread(input.workspace_id, threadId)
      if (input.action === 'guide')
        return { workspace_id: input.workspace_id, guide: CONTROLLER_GUIDANCE }
      if (input.action === 'inspect')
        return {
          ...status(input.workspace_id),
          workspace: services.workspaceStore.getWorkspaceSnapshot(input.workspace_id).summary,
          recent_progress: persistence.recentProgress(input.workspace_id),
          recent_task_messages: getStore()
            .listRecentDispatchMessages(input.workspace_id)
            .map(serializeDispatchMessage),
          task_messages: getStore()
            .listActionableDispatchMessages(
              input.workspace_id,
              `${input.workspace_id}:orchestrator`
            )
            .map((message) => ({
              id: message.id,
              dispatch_id: message.dispatchId,
              kind: message.kind,
              text: message.text,
              delivery_state: message.deliveryState,
            })),
          members: enrichTeamList(
            input.workspace_id,
            getStore(),
            getStore().listWorkers(input.workspace_id)
          ).map((item) => serializeTeamListItem(item)),
          dispatches: getStore()
            .listOpenDispatches(input.workspace_id)
            .map((item) => ({
              dispatch_id: item.id,
              worker_id: item.toAgentId,
              status: item.status,
              outcome: item.outcome ?? null,
              delegated_from_id: item.delegatedFromId ?? null,
              text: item.text,
              parent_dispatch_id: item.parentDispatchId ?? null,
              root_dispatch_id: item.rootDispatchId ?? item.id,
            })),
        }
      if (input.action === 'question') {
        const result = getStore().getDispatchQuestion(
          input.workspace_id,
          `${input.workspace_id}:orchestrator`,
          controllerString(input, 'question_id')
        )
        return {
          status: result.status,
          question: serializeDispatchMessage(result.question),
          answers: result.answers.map(serializeDispatchMessage),
        }
      }
      if (input.action === 'messages')
        return serializeDispatchMessagesResult(
          getStore().listDispatchMessages(
            input.workspace_id,
            `${input.workspace_id}:orchestrator`,
            controllerString(input, 'dispatch_id'),
            input.after_seq as number | undefined
          )
        )
      if (input.action === 'read_reports')
        return {
          reports: persistence.readReports(input.workspace_id),
          pending_reports: persistence.pendingCount(input.workspace_id),
        }
      if (input.action === 'ack_reports') {
        persistence.ackReports(input.workspace_id, input.report_ids as number[])
        return { pending_reports: persistence.pendingCount(input.workspace_id) }
      }
      const operationId = controllerString(input, 'operation_id')
      const inputJson = JSON.stringify(input, Object.keys(input).sort())
      const reservation = persistence.reserveOperation(
        input.workspace_id,
        threadId,
        operationId,
        inputJson
      )
      if (reservation.replay) return reservation.result
      try {
        const result = await executeControllerMutation(getStore(), input, hivePort)
        persistence.finishOperation(input.workspace_id, operationId, 'completed', result)
        notifier.notify()
        return result
      } catch (error) {
        persistence.finishOperation(input.workspace_id, operationId, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
  // The runtime owns the controller transport. The team protocol still commits
  // the same report/status facts without knowing which host receives them.
  const reportTask: RuntimeStore['reportTask'] = (workspaceId, workerId, input) => {
    const result = services.teamOps.reportTask(workspaceId, workerId, input)
    if (
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode ===
        'codex_app' &&
      result.dispatch?.fromAgentId === `${workspaceId}:orchestrator`
    ) {
      return { ...result, deliveryState: 'queued', forwardError: null }
    }
    return result
  }
  const statusTask: RuntimeStore['statusTask'] = (workspaceId, workerId, input) =>
    services.teamOps.statusTask(
      workspaceId,
      workerId,
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode ===
        'codex_app'
        ? { ...input, requireActiveRun: false }
        : input
    )
  return {
    methods,
    reportTask,
    statusTask,
    close: async () => {
      closing = true
      clearInterval(timer)
      await notifier.close()
    },
  }
}
