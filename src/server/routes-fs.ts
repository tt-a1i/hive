import { browseDirectory, probeDirectory } from './fs-browse.js'
import { pickFolder } from './fs-pick-folder.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const readPathParam = (request: { url?: string | undefined }): string => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('path') ?? ''
}

export const fsRoutes: RouteDefinition[] = [
  route('GET', '/api/fs/browse', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await browseDirectory(readPathParam(request))
    sendJson(response, body.ok ? 200 : 400, body)
  }),
  route('GET', '/api/fs/probe', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await probeDirectory(readPathParam(request))
    sendJson(response, 200, body)
  }),
  route('POST', '/api/fs/pick-folder', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await pickFolder()
    sendJson(response, 200, body)
  }),
]
