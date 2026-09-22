import type { DispatchMessageKind } from '../shared/team-collaboration.js'
import { serializeDispatchMessage } from './dispatch-message-serializer.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import { resolveExplicitSpawnCliLaunchConfig } from './spawn-cli-resolver.js'
import { resolveSpawnWorkerDefaults } from './spawn-worker-defaults.js'
import { getOrchestratorId } from './workspace-store-support.js'
import { resolveWorkspaceUiLanguage } from './workspace-ui-language.js'

export type ControllerActionInput = Record<string, unknown> & {
  workspace_id: string
  action: string
}
const fields: Record<string, readonly string[]> = {
  guide: [],
  inspect: [],
  read_reports: [],
  ack_reports: ['report_ids'],
  send: ['worker_name', 'text', 'operation_id', 'related_to_dispatch_id'],
  message: ['dispatch_id', 'kind', 'text', 'operation_id', 'reply_to'],
  messages: ['dispatch_id', 'after_seq'],
  question: ['question_id'],
  reply: ['question_id', 'text', 'operation_id'],
  spawn: ['role', 'cli', 'name', 'operation_id'],
  start: ['worker_name', 'operation_id'],
  stop: ['worker_name', 'operation_id'],
  cancel: ['dispatch_id', 'reason', 'operation_id'],
}
export const controllerString = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestError(`${key} must be a non-empty string`)
  if (value.length > (key === 'text' ? 100_000 : 1024))
    throw new BadRequestError(`${key} is too long`)
  return value
}
export const validateControllerAction = (input: ControllerActionInput) => {
  const allowed = fields[input.action]
  if (!allowed) throw new BadRequestError('Unknown controller action')
  for (const key of Object.keys(input)) {
    if (!['workspace_id', 'action', ...allowed].includes(key))
      throw new BadRequestError(`Unexpected field: ${key}`)
  }
  for (const key of allowed) {
    if (
      ['name', 'related_to_dispatch_id', 'reply_to', 'after_seq'].includes(key) &&
      input[key] === undefined
    )
      continue
    if (key === 'after_seq') {
      if (!Number.isSafeInteger(input.after_seq) || (input.after_seq as number) < 0)
        throw new BadRequestError('after_seq must be a nonnegative integer')
      continue
    }
    if (key === 'report_ids') {
      if (
        !Array.isArray(input.report_ids) ||
        input.report_ids.length > 100 ||
        input.report_ids.some((id) => !Number.isSafeInteger(id) || id < 1)
      ) {
        throw new BadRequestError('report_ids must contain up to 100 positive integer IDs')
      }
    } else controllerString(input, key)
  }
  if (input.action === 'message' && !['note', 'question', 'answer'].includes(String(input.kind)))
    throw new BadRequestError('Controller message kind must be note, question, or answer')
}
const serializeDispatch = (dispatch: Awaited<ReturnType<RuntimeStore['dispatchTask']>>) => ({
  dispatch_id: dispatch.id,
  status: dispatch.status,
  worker_id: dispatch.toAgentId,
  parent_dispatch_id: dispatch.parentDispatchId ?? null,
  root_dispatch_id: dispatch.rootDispatchId ?? dispatch.id,
})
export const executeControllerMutation = async (
  store: RuntimeStore,
  input: ControllerActionInput,
  hivePort: string
): Promise<unknown> => {
  const workspaceId = input.workspace_id
  const fromAgentId = getOrchestratorId(workspaceId)
  const worker = () => {
    const name = controllerString(input, 'worker_name')
    const result = store.listWorkers(workspaceId).find((item) => item.name === name)
    if (!result) throw new BadRequestError(`No member named ${name}`)
    return result
  }
  switch (input.action) {
    case 'reply': {
      const reply = store.getDispatchReplyInput(
        workspaceId,
        fromAgentId,
        controllerString(input, 'question_id'),
        controllerString(input, 'text')
      )
      return {
        message: serializeDispatchMessage(
          store.sendDispatchMessage(workspaceId, fromAgentId, reply)
        ),
      }
    }
    case 'send': {
      const target = worker()
      const dispatch = await store.dispatchTaskByWorkerName(
        workspaceId,
        target.name,
        controllerString(input, 'text'),
        {
          fromAgentId,
          hivePort,
          ...(input.related_to_dispatch_id !== undefined
            ? { relatedToDispatchId: controllerString(input, 'related_to_dispatch_id') }
            : {}),
          autoStartWorker:
            target.spawnedBy === 'orchestrator' && store.listAgentRuns(target.id).length === 0,
        }
      )
      return { ...serializeDispatch(dispatch), queued: dispatch.queuedForStoppedWorker === true }
    }
    case 'message': {
      const message = store.sendDispatchMessage(workspaceId, fromAgentId, {
        dispatchId: controllerString(input, 'dispatch_id'),
        kind: input.kind as DispatchMessageKind,
        text: controllerString(input, 'text'),
        ...(input.reply_to !== undefined ? { replyTo: controllerString(input, 'reply_to') } : {}),
      })
      return { message: serializeDispatchMessage(message) }
    }
    case 'spawn': {
      const cli = controllerString(input, 'cli')
      const launch = resolveExplicitSpawnCliLaunchConfig(
        {
          getCommandPreset: (id) => store.settings.getCommandPreset(id),
          getOrchestratorLaunchConfig: () => undefined,
        },
        cli
      )
      const defaults = resolveSpawnWorkerDefaults({
        language: resolveWorkspaceUiLanguage(store.settings, workspaceId),
        requestedRole: controllerString(input, 'role'),
        requestedName: typeof input.name === 'string' ? input.name : undefined,
        takenNames: new Set(store.listWorkers(workspaceId).map((item) => item.name)),
      })
      const created = store.addWorkerWithLaunch(
        workspaceId,
        { ...defaults, spawnedBy: 'orchestrator', ephemeral: false },
        launch
      )
      return { worker_id: created.id, name: created.name, status: created.status }
    }
    case 'start': {
      const target = worker()
      const existing = store.getActiveRunByAgentId(workspaceId, target.id)
      if (existing) return { worker_id: target.id, run_id: existing.runId, status: existing.status }
      const run = await store.startAgent(workspaceId, target.id, { hivePort })
      return { worker_id: target.id, run_id: run.runId, status: run.status }
    }
    case 'stop': {
      const target = worker()
      const run = store.getActiveRunByAgentId(workspaceId, target.id)
      if (run) store.stopAgentRun(run.runId)
      return { worker_id: target.id, stop_requested: Boolean(run) }
    }
    case 'cancel': {
      const dispatchId = controllerString(input, 'dispatch_id')
      const dispatch = store.listOpenDispatches(workspaceId).find((item) => item.id === dispatchId)
      if (!dispatch || dispatch.fromAgentId !== fromAgentId || dispatch.workflowRunId !== null)
        throw new ConflictError('No open controller dispatch with this ID')
      const result = await store.cancelTask(workspaceId, dispatchId, {
        fromAgentId,
        reason: controllerString(input, 'reason'),
      })
      return {
        dispatch_id: dispatchId,
        status: 'cancelled',
        forwarded: result.forwarded,
        forward_error: result.forwardError,
      }
    }
    default:
      throw new BadRequestError('Not a controller mutation')
  }
}
