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
import { discussRoutes } from './routes-discuss.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { fsRoutes } from './routes-fs.js'
import { marketplaceRoutes } from './routes-marketplace.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { runtimeRoutes } from './routes-runtime.js'
import { settingsRoutes } from './routes-settings.js'
import { taskRoutes } from './routes-tasks.js'
import { taskApiRoutes } from './routes-tasks-api.js'
import { teamRoutes } from './routes-team.js'
import { uiRoutes } from './routes-ui.js'
import { versionRoutes } from './routes-version.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...workspaceRoutes,
  ...openWorkspaceRoutes,
  ...dispatchRoutes,
  ...versionRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...taskRoutes,
  ...taskApiRoutes,
  ...runtimeRoutes,
  ...teamRoutes,
  ...discussRoutes,
  ...fsRoutes,
  ...marketplaceRoutes,
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
