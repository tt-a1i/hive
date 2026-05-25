import { resolveCommandPath } from './agent-command-resolver.js'
import type { DiscussionTriggers } from './discussion-templates.js'
import { loadExternalAgents } from './external-agents-loader.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { SessionIdCaptureConfig } from './session-capture.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

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
  discussion_triggers: DiscussionTriggers | null
  suggested_name: string | null
  command_preset_id: string | null
}

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
  let available = false
  try {
    if (preset.command.trim()) {
      resolveCommandPath(preset.command, process.cwd(), { ...process.env, ...preset.env })
      available = true
    }
  } catch {
    available = false
  }

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
  discussionTriggers?: DiscussionTriggers | null
  suggestedName?: string | null
  commandPresetId?: string | null
  useCount?: number
  source?: 'builtin' | 'user' | 'external'
  readonly?: boolean
}) => ({
  id: template.id,
  name: template.name,
  role_type: template.roleType,
  description: template.description,
  default_command: template.defaultCommand,
  default_args: template.defaultArgs,
  default_env: template.defaultEnv,
  is_builtin: template.isBuiltin,
  discussion_triggers: template.discussionTriggers ?? null,
  suggested_name: template.suggestedName ?? null,
  command_preset_id: template.commandPresetId ?? null,
  use_count: template.useCount ?? 0,
  source: template.source ?? (template.isBuiltin ? 'builtin' : 'user'),
  readonly: template.readonly ?? template.isBuiltin,
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
  return {
    name: body.name ?? '',
    roleType: body.role_type ?? 'custom',
    description: body.description ?? '',
    defaultCommand: body.default_command ?? '',
    defaultArgs: body.default_args ?? [],
    defaultEnv: body.default_env ?? {},
    discussionTriggers: body.discussion_triggers ?? null,
    suggestedName: body.suggested_name ?? null,
    commandPresetId: body.command_preset_id ?? null,
  }
}

export const settingsRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/command-presets', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.settings.listCommandPresets().map(serializeCommandPreset))
  }),
  route('POST', '/api/settings/command-presets', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
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
      requireUiTokenFromRequest(request, store.validateUiToken)
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
      requireUiTokenFromRequest(request, store.validateUiToken)
      const presetId = getRequiredParam(response, params, 'presetId', 'Preset id is required')
      if (!presetId) return
      store.settings.deleteCommandPreset(presetId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/role-templates', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const dbTemplates = store.settings.listRoleTemplates().map(serializeRoleTemplate)
    const externalDir = store.settings.getAppState('external_agents_dir')?.value
      ?? process.env.HIVE_EXTERNAL_AGENTS_DIR
      ?? `${process.env.HOME}/ai/oh-my-claudecode/agents`
    const externalTemplates = loadExternalAgents(externalDir).map(serializeRoleTemplate)
    sendJson(response, 200, [...dbTemplates, ...externalTemplates])
  }),
  route('POST', '/api/settings/role-templates', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
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
      requireUiTokenFromRequest(request, store.validateUiToken)
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
      requireUiTokenFromRequest(request, store.validateUiToken)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      store.settings.deleteRoleTemplate(templateId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/app-state/:key', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    sendJson(response, 200, store.settings.getAppState(key) ?? { key, value: null })
  }),
  route('PUT', '/api/settings/app-state/:key', async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    const body = await readJsonBody<{ value: string | null }>(request)
    store.settings.setAppState(key, body.value)
    response.statusCode = 204
    response.end()
  }),
]
