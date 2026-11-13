import { isCommandAvailableOnPath } from './agent-command-resolver.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import {
  isRemoteConfigKey,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
} from './remote-config-keys.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteContext, RouteDefinition } from './route-types.js'
import type { SessionIdCaptureConfig } from './session-capture.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import {
  assertValidWorkflowCliPolicy,
  CANONICAL_WORKFLOW_CLIS,
  readWorkflowCliPolicy,
  WORKFLOW_CLI_POLICY_KEY,
  type WorkflowCliPolicy,
} from './workflow-cli-policy.js'
import {
  readWorkflowEnabled,
  serializeWorkflowEnabled,
  WORKFLOW_ENABLED_KEY,
} from './workflow-feature.js'

type CommandPresetBody = {
  display_name: string
  command: string
  args: string[]
  env: Record<string, string>
  resume_args_template: string | null
  session_id_capture: SessionIdCaptureConfig | null
  yolo_args_template: string[] | null
}

type RoleTemplateBody = {
  name: string
  role_type: 'orchestrator' | 'coder' | 'reviewer' | 'tester' | 'custom'
  description: string
  default_command: string
  default_args: string[]
  default_env: Record<string, string>
}

const ROLE_TEMPLATE_TYPES = new Set(['orchestrator', 'coder', 'reviewer', 'tester', 'custom'])

const serializeCommandPreset = (preset: {
  id: string
  displayName: string
  command: string
  args: string[]
  env: Record<string, string>
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
  isBuiltin: boolean
}) => {
  const available = isCommandAvailableOnPath(preset.command, preset.env)

  return {
    id: preset.id,
    display_name: preset.displayName,
    command: preset.command,
    args: preset.args,
    env: preset.env,
    resume_args_template: preset.resumeArgsTemplate,
    session_id_capture: preset.sessionIdCapture,
    yolo_args_template: preset.yoloArgsTemplate,
    is_builtin: preset.isBuiltin,
    available,
  }
}

const serializeRoleTemplate = (template: {
  id: string
  name: string
  roleType: string
  description: string
  defaultCommand: string
  defaultArgs: string[]
  defaultEnv: Record<string, string>
  isBuiltin: boolean
}) => ({
  id: template.id,
  name: template.name,
  role_type: template.roleType,
  description: template.description,
  default_command: template.defaultCommand,
  default_args: template.defaultArgs,
  default_env: template.defaultEnv,
  is_builtin: template.isBuiltin,
})

const readCommandPresetBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  const body = await readJsonBody<Partial<CommandPresetBody>>(request)
  return {
    displayName: body.display_name ?? '',
    command: body.command ?? '',
    args: body.args ?? [],
    env: body.env ?? {},
    resumeArgsTemplate: body.resume_args_template ?? null,
    sessionIdCapture: body.session_id_capture ?? null,
    yoloArgsTemplate: body.yolo_args_template ?? null,
  }
}

const readRoleTemplateBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  const body = await readJsonBody<Partial<RoleTemplateBody>>(request)
  const roleType = body.role_type ?? 'custom'
  if (!ROLE_TEMPLATE_TYPES.has(roleType)) {
    throw new BadRequestError('Invalid role_type')
  }
  return {
    name: body.name ?? '',
    roleType,
    description: body.description ?? '',
    defaultCommand: body.default_command ?? '',
    defaultArgs: body.default_args ?? [],
    defaultEnv: body.default_env ?? {},
  }
}

// Remote-config KV keys (remote-config-keys.ts) are a different trust domain from
// equal-authority daemon API. Tunnel-origin requests must not read or write them
// (token leak + Remote-ON persist). remote_enabled writes are rejected from every
// origin so the only arming path is PUT /api/remote/enabled.
const assertAppStateKeyAllowed = (
  ctx: Pick<RouteContext, 'request' | 'store'>,
  key: string,
  write: boolean
): void => {
  if (!write && key === REMOTE_DAEMON_TOKEN_KEY) {
    throw new ForbiddenError('Remote daemon token is not available through app state')
  }
  if (write && key === REMOTE_ENABLED_KEY) {
    throw new ForbiddenError('remote_enabled can only be changed via /api/remote/enabled')
  }
  if (isRemoteConfigKey(key) && ctx.store.authorizeRemoteTunnelRequest(ctx.request)) {
    throw new ForbiddenError('remote configuration is not available over the tunnel')
  }
}

export const settingsRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/command-presets', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(response, 200, store.settings.listCommandPresets().map(serializeCommandPreset))
  }),
  route('POST', '/api/settings/command-presets', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(
      response,
      201,
      serializeCommandPreset(
        store.settings.createCommandPreset(await readCommandPresetBody(request))
      )
    )
  }),
  route(
    'PATCH',
    '/api/settings/command-presets/:presetId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const presetId = getRequiredParam(response, params, 'presetId', 'Preset id is required')
      if (!presetId) return
      const current = store.settings.listCommandPresets().find((preset) => preset.id === presetId)
      if (!current) throw new Error(`Command preset not found: ${presetId}`)
      const next = { ...current, ...(await readCommandPresetBody(request)) }
      sendJson(
        response,
        200,
        serializeCommandPreset(store.settings.updateCommandPreset(presetId, next))
      )
    }
  ),
  route(
    'DELETE',
    '/api/settings/command-presets/:presetId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const presetId = getRequiredParam(response, params, 'presetId', 'Preset id is required')
      if (!presetId) return
      store.settings.deleteCommandPreset(presetId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/role-templates', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(response, 200, store.settings.listRoleTemplates().map(serializeRoleTemplate))
  }),
  route('POST', '/api/settings/role-templates', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(
      response,
      201,
      serializeRoleTemplate(store.settings.createRoleTemplate(await readRoleTemplateBody(request)))
    )
  }),
  route(
    'PATCH',
    '/api/settings/role-templates/:templateId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      const current = store.settings
        .listRoleTemplates()
        .find((template) => template.id === templateId)
      if (!current) throw new Error(`Role template not found: ${templateId}`)
      const next = { ...current, ...(await readRoleTemplateBody(request)) }
      sendJson(
        response,
        200,
        serializeRoleTemplate(store.settings.updateRoleTemplate(templateId, next))
      )
    }
  ),
  route(
    'DELETE',
    '/api/settings/role-templates/:templateId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      store.settings.deleteRoleTemplate(templateId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/app-state/:key', (ctx) => {
    const { params, request, response, store } = ctx
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    assertAppStateKeyAllowed(ctx, key, false)
    sendJson(response, 200, store.settings.getAppState(key) ?? { key, value: null })
  }),
  route('PUT', '/api/settings/app-state/:key', async (ctx) => {
    const { params, request, response, store } = ctx
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    assertAppStateKeyAllowed(ctx, key, true)
    const body = await readJsonBody<{ value: string | null }>(request)
    store.settings.setAppState(key, body.value)
    response.statusCode = 204
    response.end()
  }),
  route('GET', '/api/settings/workflow-cli-policy', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const policy = readWorkflowCliPolicy(
      store.settings.getAppState(WORKFLOW_CLI_POLICY_KEY)?.value ?? null
    )
    sendJson(response, 200, { ...policy, supported: [...CANONICAL_WORKFLOW_CLIS] })
  }),
  route('PUT', '/api/settings/workflow-cli-policy', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const body = await readJsonBody<unknown>(request)
    // Strict validation: a bad payload is rejected (400) rather than persisted.
    const clean: WorkflowCliPolicy = ((): WorkflowCliPolicy => {
      try {
        return assertValidWorkflowCliPolicy(body)
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error))
      }
    })()
    store.settings.setAppState(WORKFLOW_CLI_POLICY_KEY, JSON.stringify(clean))
    sendJson(response, 200, { ...clean, supported: [...CANONICAL_WORKFLOW_CLIS] })
  }),
  route('GET', '/api/settings/workflow-feature', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const enabled = readWorkflowEnabled(
      store.settings.getAppState(WORKFLOW_ENABLED_KEY)?.value ?? null
    )
    sendJson(response, 200, { enabled })
  }),
  route('PUT', '/api/settings/workflow-feature', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const body = await readJsonBody<{ enabled?: unknown }>(request)
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestError('workflow-feature requires { enabled: boolean }')
    }
    store.settings.setAppState(WORKFLOW_ENABLED_KEY, serializeWorkflowEnabled(body.enabled))
    sendJson(response, 200, { enabled: body.enabled })
  }),
]
