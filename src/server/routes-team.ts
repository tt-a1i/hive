import type { TeamListItem } from '../shared/types.js'
import { validateCronNextRunAt } from './cron-util.js'
import { readFeatureFlags } from './feature-flags.js'
import { buildProtocolGuide, isProtocolGuideTopic } from './hive-team-guidance.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CancelTaskBody,
  DismissAgentBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  SpawnAgentBody,
  WorkflowControlBody,
  WorkflowRunBody,
  WorkflowScheduleBody,
} from './route-types.js'
import { optionalSequence } from './routes-team-messages.js'
import {
  resolveDefaultSpawnCliLaunchConfig,
  resolveExplicitSpawnCliLaunchConfig,
  type SpawnCliResolverPorts,
} from './spawn-cli-resolver.js'
import { resolveSpawnWorkerDefaults } from './spawn-worker-defaults.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { readWorkflowCliPolicy, WORKFLOW_CLI_POLICY_KEY } from './workflow-cli-policy.js'
import { readWorkflowEnabled, WORKFLOW_ENABLED_KEY } from './workflow-feature.js'
import { getOrchestratorId } from './workspace-store-support.js'
import { resolveWorkspaceUiLanguage } from './workspace-ui-language.js'

const shouldAutoStartTeamSendTarget = (
  store: Parameters<RouteDefinition['handler']>[0]['store'],
  targetWorker: TeamListItem | undefined
): boolean =>
  targetWorker?.spawnedBy === 'orchestrator' && store.listAgentRuns(targetWorker.id).length === 0

// Experimental gate: `team workflow run` / `team workflow schedule` only work
// when the user has enabled workflows in Settings. Off by default. The PTY
// runner itself isn't gated (internal API + the scheduler gate handle that) —
// this is the agent-facing entry point, so the orchestrator gets a clear,
// actionable error instead of a silent no-op.
const requireWorkflowsEnabled = (store: {
  settings: { getAppState: (key: string) => { value: string | null } | undefined }
}) => {
  if (!readWorkflowEnabled(store.settings.getAppState(WORKFLOW_ENABLED_KEY)?.value ?? null)) {
    throw new ForbiddenError(
      'Workflows are an experimental Hive feature and are currently disabled. ' +
        'Enable them in Hive Settings (the gear menu, top-right) to use `team workflow`. ' +
        'Until then, dispatch work with `team send`.'
    )
  }
}

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const REPORT_STATUSES = new Set(['success', 'failed'])
const getReportStatus = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !REPORT_STATUSES.has(value)) {
    throw new BadRequestError('Invalid status; expected success or failed')
  }
  return value as 'success' | 'failed'
}

/* P0-B2 (growth research 2026-06-11): when `team spawn` omits `--cli`, the
   default used to be a hardcoded 'claude' — instantly broken for non-Claude
   users. Now it inherits the orchestrator's CLI, falls back to the first
   built-in CLI visible on PATH, and only then to 'claude'. An explicit
   `--cli` that is missing from PATH is rejected (400) with a suggestion. */
const resolveSpawnLaunchConfig = (
  store: Parameters<RouteDefinition['handler']>[0]['store'],
  workspaceId: string,
  cli: unknown
) => {
  const ports: SpawnCliResolverPorts = {
    getCommandPreset: (id) => store.settings.getCommandPreset(id),
    getOrchestratorLaunchConfig: () =>
      store.peekAgentLaunchConfig(workspaceId, getOrchestratorId(workspaceId)),
  }
  if (cli === undefined || cli === null || cli === '') {
    return resolveDefaultSpawnCliLaunchConfig(ports)
  }
  return resolveExplicitSpawnCliLaunchConfig(ports, requireNonEmptyString(cli, 'cli'))
}

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/guide', async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestError('Expected a JSON object')
    if (
      Object.keys(body).some(
        (key) => !['project_id', 'from_agent_id', 'token', 'topic'].includes(key)
      )
    )
      throw new BadRequestError('Unexpected guide field')
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const agent = authenticateCliAgent({
      workspaceId: projectId,
      fromAgentId: requireNonEmptyString(body.from_agent_id, 'from_agent_id'),
      token: typeof body.token === 'string' ? body.token : undefined,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'help')
    if (typeof body.topic !== 'string' || !isProtocolGuideTopic(body.topic))
      throw new BadRequestError('Unknown guide topic')
    const workspace = store.getWorkspaceSnapshot(projectId).summary
    const policy = readWorkflowCliPolicy(
      store.settings.getAppState(WORKFLOW_CLI_POLICY_KEY)?.value ?? null
    )
    sendJson(response, 200, {
      project_id: projectId,
      project_path: workspace.path,
      topic: body.topic,
      guide: buildProtocolGuide(body.topic, policy, readFeatureFlags(store.settings)),
    })
  }),
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'send')
    const relatedToDispatchId =
      body.related_to_dispatch_id === undefined
        ? undefined
        : requireNonEmptyString(body.related_to_dispatch_id, 'related_to_dispatch_id')
    const targetWorker = store.listWorkers(projectId).find((worker) => worker.name === to)
    const shouldAutoStartWorker = shouldAutoStartTeamSendTarget(store, targetWorker)
    const dispatch = await store.dispatchTaskByWorkerName(projectId, to, text, {
      autoStartWorker: shouldAutoStartWorker,
      ...(relatedToDispatchId !== undefined ? { relatedToDispatchId } : {}),
      fromAgentId,
      hivePort: String(request.socket.localPort ?? ''),
    })

    /* The user-facing team send route queues work for user-managed stopped
       workers without auto-starting them. An orchestrator-spawned worker is
       different only for its first dispatch: `team spawn` is immediately
       followed by `team send`, so the send path wakes a never-started spawned
       worker to keep that natural flow from parking forever. A parked dispatch
       is flagged so the orchestrator can tell the user the worker needs a
       start (replay delivers it automatically on that start). */
    sendJson(response, 202, {
      dispatch_id: dispatch.id,
      parent_dispatch_id: dispatch.parentDispatchId,
      root_dispatch_id: dispatch.rootDispatchId,
      ok: true,
      restarted_worker: dispatch.restartedWorker,
      ...(dispatch.queuedForStoppedWorker === true
        ? { queued: true, worker_status: 'stopped' }
        : {}),
    })
  }),
  route('POST', '/api/team/spawn', async ({ request, response, store }) => {
    const body = await readJsonBody<SpawnAgentBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'spawn')
    const language = resolveWorkspaceUiLanguage(store.settings, projectId, body.locale)
    const { role, name, description } = resolveSpawnWorkerDefaults({
      language,
      requestedRole: typeof body.role === 'string' ? body.role : undefined,
      requestedName: typeof body.name === 'string' ? body.name : undefined,
      takenNames: new Set(store.listWorkers(projectId).map((worker) => worker.name)),
    })
    const launchConfig = resolveSpawnLaunchConfig(store, projectId, body.cli)
    // M11: default is persistent (acts like a normal member); --ephemeral
    // opts into auto-dismiss-after-first-report (mirrors workflow workers,
    // but orchestrator-spawned). Existing M1-D cascade-on-orchestrator-exit
    // still applies to whatever ephemeral workers remain.
    const ephemeral = body.ephemeral === true
    const workerInput = {
      name,
      role,
      ...(description !== undefined ? { description } : {}),
      ...(ephemeral ? { ephemeral: true as const } : {}),
      spawnedBy: 'orchestrator' as const,
    }
    const worker = store.addWorkerWithLaunch(projectId, workerInput, launchConfig)
    sendJson(response, 201, {
      name: worker.name,
      ok: true,
      worker_id: worker.id,
      ephemeral,
    })
  }),
  route('POST', '/api/team/workflow/run', async ({ request, response, store }) => {
    const body = await readJsonBody<WorkflowRunBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const source = requireNonEmptyString(body.source, 'source')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workflow')
    // Feature gate AFTER auth so an unauthenticated caller gets 401/400, not a
    // 403 that leaks whether the experiment is on.
    requireWorkflowsEnabled(store)
    const hivePort = String(request.socket.localPort ?? '')
    const input: Parameters<typeof store.startWorkflowInline>[0] = {
      workspaceId: projectId,
      source,
      hivePort,
      triggeredByAgentId: fromAgentId,
      ...(body.args !== undefined ? { args: body.args } : {}),
      ...(typeof body.name === 'string' && body.name.trim()
        ? { scriptPath: `<inline:${body.name.trim()}>` }
        : {}),
    }
    const run = await store.startWorkflowInline(input)
    sendJson(response, 202, { ok: true, run_id: run.id, name: run.name, status: run.status })
  }),
  /* Agent-initiated scheduling. Workflows are authored by the orchestrator,
     not picked from a human script library — so registering a recurring run
     is also an agent action: the orchestrator passes the workflow source +
     a cron, and the runtime persists the source (so cron can fire it with no
     orchestrator in the loop) and registers the schedule. The UI only
     lists / pauses / deletes schedules; it cannot create them. */
  route('POST', '/api/team/workflow/schedule', async ({ request, response, store }) => {
    const body = await readJsonBody<WorkflowScheduleBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const source = requireNonEmptyString(body.source, 'source')
    const name = requireNonEmptyString(body.name, 'name')
    const cron = requireNonEmptyString(body.cron, 'cron')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workflow')
    // Feature gate AFTER auth (see /run above).
    requireWorkflowsEnabled(store)
    const nextRunAt = validateCronNextRunAt(cron)
    const schedule = await store.scheduleWorkflowInline({
      workspaceId: projectId,
      source,
      name,
      cron,
      nextRunAt,
      ...(body.args !== undefined ? { args: body.args } : {}),
    })
    sendJson(response, 201, {
      ok: true,
      schedule_id: schedule.id,
      script_path: schedule.scriptPath,
      cron: schedule.cron,
      next_run_at: schedule.nextRunAt,
    })
  }),
  route('POST', '/api/team/workflow/stop', async ({ request, response, store }) => {
    const body = await readJsonBody<WorkflowControlBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const runId = requireNonEmptyString(body.run_id, 'run_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workflow')
    const run = store.getWorkflowRun(runId)
    if (!run || run.workspaceId !== projectId) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    const stopped = store.stopWorkflowRun(runId)
    sendJson(response, stopped ? 202 : 409, { ok: stopped, run_id: runId })
  }),
  /* TIER 1 #6 — per-agent transcript dump. The completion reminder injected
     into the orchestrator's stdin promised this command but it never
     existed, so any orchestrator that followed the suggestion got a
     usage error. Returns the run record + the full per-dispatch detail
     (step / phase / label / prompt / status / report text) so the
     orchestrator can read past the 200-char per-step summary cap in the
     reminder. */
  route('POST', '/api/team/workflow/show', async ({ request, response, store }) => {
    const body = await readJsonBody<WorkflowControlBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const runId = requireNonEmptyString(body.run_id, 'run_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workflow')
    const run = store.getWorkflowRun(runId)
    if (!run || run.workspaceId !== projectId) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    const dispatches = store.listWorkflowRunDispatches(runId).map((d) => ({
      step_index: d.stepIndex,
      phase: d.phase,
      label: d.label,
      to_agent_id: d.toAgentId,
      status: d.status,
      text: d.text,
      report_text: d.reportText,
      submitted_at: d.submittedAt,
      reported_at: d.reportedAt,
    }))
    sendJson(response, 200, {
      ok: true,
      run: {
        id: run.id,
        name: run.name,
        status: run.status,
        phase: run.phase,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        error: run.error,
        result: run.result,
      },
      dispatches,
    })
  }),
  route('POST', '/api/team/dismiss', async ({ request, response, store }) => {
    const body = await readJsonBody<DismissAgentBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'dismiss')
    const worker = store.listWorkers(projectId).find((item) => item.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `No such worker: ${name}` })
      return
    }
    store.deleteWorker(projectId, worker.id)
    sendJson(response, 200, { ok: true })
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const reason = requireNonEmptyString(body.reason, 'reason')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'cancel')
    const result = await store.cancelTask(projectId, dispatchId, { fromAgentId, reason })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'report')
    const seenSeq = optionalSequence(body.seen_seq, 'seen_seq')
    if (seenSeq !== undefined && !body.dispatch_id)
      throw new BadRequestError('seen_seq requires dispatch_id')
    if (body.dispatch_id !== undefined) requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const reportInput = {
      ...(body.ack_batch_id !== undefined
        ? { ackBatchId: requireNonEmptyString(body.ack_batch_id, 'ack_batch_id') }
        : {}),
      ...(seenSeq !== undefined ? { seenSeq } : {}),
      artifacts: getArtifacts(body.artifacts),
      ...(typeof body.dispatch_id === 'string' ? { dispatchId: body.dispatch_id } : {}),
      requireActiveRun: true,
      text: resultText,
    }
    const status = getReportStatus(body.status)
    if (status !== undefined) {
      const result = store.reportTask(projectId, fromAgentId, {
        ...reportInput,
        status,
      })
      sendJson(response, 202, {
        delivery_state: result.deliveryState,
        outcome: result.dispatch?.outcome ?? null,
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
        ...(result.pendingWarning ? { pending_warning: result.pendingWarning } : {}),
      })
      return
    } else {
      const result = store.reportTask(projectId, fromAgentId, reportInput)
      sendJson(response, 202, {
        outcome: result.dispatch?.outcome ?? null,
        delivery_state: result.deliveryState,
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
        ...(result.pendingWarning ? { pending_warning: result.pendingWarning } : {}),
      })
      return
    }
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'status')
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: getArtifacts(body.artifacts),
      requireActiveRun: true,
      text: resultText,
    })
    sendJson(response, 202, {
      delivery_state: result.deliveryState,
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
      ...(result.pendingWarning ? { pending_warning: result.pendingWarning } : {}),
    })
    return
  }),
]
