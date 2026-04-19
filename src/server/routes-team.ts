import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { ReportTaskBody, RouteDefinition, SendTaskBody } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const agent = authenticateCliAgent({
      fromAgentId: body.from_agent_id,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: body.project_id,
    })
    requireCommandForRole(agent, 'send')
    store.dispatchTaskByWorkerName(body.project_id, body.to, body.text, {
      fromAgentId: body.from_agent_id,
    })

    sendJson(response, 202, { ok: true })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const agent = authenticateCliAgent({
      fromAgentId: body.from_agent_id,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: body.project_id,
    })
    requireCommandForRole(agent, 'report')
    const status = body.status === 'success' || body.status === 'failed' ? body.status : 'success'
    store.reportTask(body.project_id, body.from_agent_id, {
      artifacts: body.artifacts.filter((item): item is string => typeof item === 'string'),
      requireActiveRun: true,
      status,
      text: body.result,
    })
    sendJson(response, 202, { ok: true })
  }),
]
