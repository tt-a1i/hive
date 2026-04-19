import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const uiRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/session', ({ response, store }) => {
    response.setHeader(
      'set-cookie',
      `hive_ui_token=${store.getUiToken()}; Path=/; HttpOnly; SameSite=Strict`
    )
    sendJson(response, 200, { ok: true })
  }),
]
