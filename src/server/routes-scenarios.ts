import type { IncomingMessage } from 'node:http'
import type { WorkerRole } from '../shared/types.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import {
  buildScenarioKickoffMessage,
  buildScenarioWorkerName,
  getScenarioPreset,
  getScenarioWorkerDescription,
  type ScenarioPreset,
} from './scenario-presets.js'
import {
  type CliAvailabilityProbe,
  resolveDefaultSpawnCliLaunchConfig,
  type SpawnCliResolverPorts,
} from './spawn-cli-resolver.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { getOrchestratorId } from './workspace-store-support.js'
import {
  resolveWorkspaceUiLanguage,
  type UiLanguage,
  writeWorkspaceUiLanguage,
} from './workspace-ui-language.js'

interface ApplyScenarioBody {
  goal?: unknown
  locale?: unknown
}

type CreatedScenarioWorker = { id: string; name: string; role: WorkerRole }
type StartedScenarioWorker = CreatedScenarioWorker & {
  start: { ok: true; run_id: string }
}

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

export const scenarioRoutes: RouteDefinition[] = [
  /**
   * One-click team assembly: materialize a scenario preset's members, start
   * their PTYs, then hand the user's goal to the orchestrator as a normal user
   * message. Deliberately NOT dispatching — splitting the goal and calling
   * `team send` stays the orchestrator's job.
   */
  route(
    'POST',
    '/api/workspaces/:workspaceId/scenarios/:scenarioId/apply',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and scenario id are required'
      )
      const scenarioId = getRequiredParam(
        response,
        params,
        'scenarioId',
        'Workspace id and scenario id are required'
      )
      if (!workspaceId || !scenarioId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }
      const scenario = getScenarioPreset(scenarioId)
      if (!scenario) {
        sendJson(response, 404, { error: `Unknown scenario: ${scenarioId}` })
        return
      }

      const body = await readJsonBody<ApplyScenarioBody>(request)
      const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
      if (!goal) {
        throw new BadRequestError('Missing goal')
      }
      const language = resolveWorkspaceUiLanguage(store.settings, workspaceId, body.locale)
      writeWorkspaceUiLanguage(store.settings, workspaceId, language)

      // The kickoff must land in the orchestrator's live terminal. Gate up
      // front so a stopped orchestrator never gets a half-created scenario.
      if (!store.getActiveRunByAgentId(workspaceId, getOrchestratorId(workspaceId))) {
        throw new ConflictError(
          'Start the Orchestrator first — the scenario goal is handed to its terminal'
        )
      }

      const created = await applyAndStartScenario(
        store,
        workspaceId,
        scenario,
        goal,
        getRuntimePort(request),
        undefined,
        language
      )
      sendJson(response, 201, {
        created_workers: created,
        injected: true,
      })
    }
  ),
]

/**
 * Materialize the scenario team and hand the goal to the orchestrator.
 * Exported for direct testing (the route harness has no PTY, so the
 * active-run/start behavior would mask this logic).
 *
 * Workers derive a FRESH launch config from the orchestrator's CLI brand via
 * the same resolver `team spawn` uses — never a clone of the orchestrator's
 * own config, which may carry session-resume arguments that would make every
 * worker resume the orchestrator's session.
 *
 * Worker creation is sequential and NOT transactional across workers: each
 * addWorkerWithLaunch is atomic, but a mid-loop failure (e.g. a name race)
 * leaves earlier workers in place and surfaces the error to the caller.
 */
const createScenarioWorkers = (
  store: RuntimeStore,
  workspaceId: string,
  scenario: ScenarioPreset,
  isCommandAvailable?: CliAvailabilityProbe,
  language: UiLanguage = 'en'
): CreatedScenarioWorker[] => {
  const ports: SpawnCliResolverPorts = {
    getCommandPreset: (id) => store.settings.getCommandPreset(id),
    getOrchestratorLaunchConfig: () =>
      store.peekAgentLaunchConfig(workspaceId, getOrchestratorId(workspaceId)),
    ...(isCommandAvailable ? { isCommandAvailable } : {}),
  }
  const launchConfig = resolveDefaultSpawnCliLaunchConfig(ports)

  const takenNames = new Set(store.listWorkers(workspaceId).map((worker) => worker.name))
  const created: CreatedScenarioWorker[] = []
  for (const spec of scenario.workers) {
    const name = buildScenarioWorkerName(spec, takenNames)
    takenNames.add(name)
    const description =
      spec.descriptionOverride !== undefined
        ? getScenarioWorkerDescription(spec, language)
        : undefined
    const worker = store.addWorkerWithLaunch(
      workspaceId,
      {
        name,
        role: spec.role,
        ...(description !== undefined ? { description } : {}),
      },
      launchConfig
    )
    created.push({ id: worker.id, name: worker.name, role: spec.role })
  }

  return created
}

const deliverScenarioKickoff = async (
  store: RuntimeStore,
  workspaceId: string,
  scenario: ScenarioPreset,
  goal: string,
  language: UiLanguage,
  created: CreatedScenarioWorker[]
) => {
  await store.deliverUserInput(
    workspaceId,
    getOrchestratorId(workspaceId),
    buildScenarioKickoffText(scenario, goal, language, created)
  )
}

const buildScenarioKickoffText = (
  scenario: ScenarioPreset,
  goal: string,
  language: UiLanguage,
  created: CreatedScenarioWorker[]
) =>
  buildScenarioKickoffMessage({
    scenarioId: scenario.id,
    goal,
    language,
    workers: created.map((worker) => ({ name: worker.name, role: worker.role })),
  })

const recordScenarioKickoff = async (
  store: RuntimeStore,
  workspaceId: string,
  scenario: ScenarioPreset,
  goal: string,
  language: UiLanguage,
  created: CreatedScenarioWorker[]
) => {
  await store.recordUserInput(
    workspaceId,
    getOrchestratorId(workspaceId),
    buildScenarioKickoffText(scenario, goal, language, created)
  )
}

export const applyScenario = async (
  store: RuntimeStore,
  workspaceId: string,
  scenario: ScenarioPreset,
  goal: string,
  isCommandAvailable?: CliAvailabilityProbe,
  language: UiLanguage = 'en'
): Promise<CreatedScenarioWorker[]> => {
  const created = createScenarioWorkers(store, workspaceId, scenario, isCommandAvailable, language)
  await recordScenarioKickoff(store, workspaceId, scenario, goal, language, created)

  return created
}

const startScenarioWorkers = async (
  store: RuntimeStore,
  workspaceId: string,
  hivePort: string,
  created: CreatedScenarioWorker[]
): Promise<StartedScenarioWorker[]> =>
  Promise.all(
    created.map(async (worker) => {
      const run = await store.startAgent(workspaceId, worker.id, { hivePort })
      if (run.status === 'error') {
        throw new ConflictError(`Failed to start scenario member: ${worker.name}`)
      }
      return { ...worker, start: { ok: true, run_id: run.runId } }
    })
  )

export const applyAndStartScenario = async (
  store: RuntimeStore,
  workspaceId: string,
  scenario: ScenarioPreset,
  goal: string,
  hivePort: string,
  isCommandAvailable?: CliAvailabilityProbe,
  language: UiLanguage = 'en'
): Promise<StartedScenarioWorker[]> => {
  const created = createScenarioWorkers(store, workspaceId, scenario, isCommandAvailable, language)
  const started = await startScenarioWorkers(store, workspaceId, hivePort, created)
  await deliverScenarioKickoff(store, workspaceId, scenario, goal, language, created)
  return started
}
