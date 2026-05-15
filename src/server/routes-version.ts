import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const versionRoutes: RouteDefinition[] = [
  route('GET', '/api/version', async ({ response, versionService }) => {
    sendJson(response, 200, await versionService.getVersionInfo())
  }),
]
