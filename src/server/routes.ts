import { matchPath } from './route-helpers.js'
import type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
} from './route-types.js'
import { actionCenterRoutes } from './routes-action-center.js'
import { agentSwitchRoutes } from './routes-agent-switch.js'
import { diagnosticsRoutes } from './routes-diagnostics.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { fsRoutes } from './routes-fs.js'
import { marketplaceRoutes } from './routes-marketplace.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { remoteRoutes } from './routes-remote.js'
import { runtimeRoutes } from './routes-runtime.js'
import { scenarioRoutes } from './routes-scenarios.js'
import { settingsRoutes } from './routes-settings.js'
import { taskRoutes } from './routes-tasks.js'
import { teamRoutes } from './routes-team.js'
import { teamMessageRoutes } from './routes-team-messages.js'
import { teamRecallRoutes } from './routes-team-recall.js'
import { teamReviewRoutes } from './routes-team-review.js'
import { uiRoutes } from './routes-ui.js'
import { versionRoutes } from './routes-version.js'
import { workerRoutes } from './routes-workers.js'
import { workflowScheduleRoutes } from './routes-workflow-schedules.js'
import { workflowRoutes } from './routes-workflows.js'
import { workspaceUploadRoutes } from './routes-workspace-uploads.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...agentSwitchRoutes,
  ...workspaceRoutes,
  ...workerRoutes,
  ...scenarioRoutes,
  ...workspaceUploadRoutes,
  ...openWorkspaceRoutes,
  ...actionCenterRoutes,
  ...diagnosticsRoutes,
  ...dispatchRoutes,
  ...versionRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...taskRoutes,
  ...runtimeRoutes,
  ...teamRecallRoutes,
  ...teamRoutes,
  ...teamReviewRoutes,
  ...teamMessageRoutes,
  ...fsRoutes,
  ...marketplaceRoutes,
  ...workflowRoutes,
  ...workflowScheduleRoutes,
  ...remoteRoutes,
]

export const matchRoute = (method: string, pathname: string) => {
  for (const routeDefinition of routes) {
    if (routeDefinition.method !== method) {
      continue
    }

    const params = matchPath(routeDefinition.path, pathname)
    if (!params) {
      continue
    }

    return {
      handler: routeDefinition.handler,
      params,
    }
  }

  return null
}

export type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
}
