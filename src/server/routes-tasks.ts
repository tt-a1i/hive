import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const taskRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      sendJson(response, 200, { content: tasksFileService.readTasks(workspace.summary.path) })
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      const body = await readJsonBody<{ content: string }>(request)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      tasksFileService.writeTasks(workspace.summary.path, body.content)
      sendJson(response, 200, { content: body.content })
    }
  ),
]
