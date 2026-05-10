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
    const dispatch = await store.dispatchTaskByWorkerName(body.project_id, body.to, body.text, {
      fromAgentId: body.from_agent_id,
      hivePort: body.hive_port ?? String(request.socket.localPort ?? ''),
    })

    sendJson(response, 202, { dispatch_id: dispatch.id, ok: true })
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
    const reportInput = {
      artifacts: (body.artifacts ?? []).filter((item): item is string => typeof item === 'string'),
      requireActiveRun: true,
      text: body.result,
    }
    if (typeof body.status === 'string') {
      const dispatch = store.reportTask(body.project_id, body.from_agent_id, {
        ...reportInput,
        status: body.status,
      })
      sendJson(response, 202, { dispatch_id: dispatch.id, ok: true })
      return
    } else {
      const dispatch = store.reportTask(body.project_id, body.from_agent_id, reportInput)
      sendJson(response, 202, { dispatch_id: dispatch.id, ok: true })
      return
    }
  }),
]
