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
import { runtimeRoutes } from './routes-runtime.js'
import { settingsRoutes } from './routes-settings.js'
import { taskRoutes } from './routes-tasks.js'
import { teamRoutes } from './routes-team.js'
import { uiRoutes } from './routes-ui.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...workspaceRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...taskRoutes,
  ...runtimeRoutes,
  ...teamRoutes,
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
