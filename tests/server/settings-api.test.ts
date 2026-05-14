import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
})

describe('settings api', () => {
  test('GET settings endpoints return builtin presets/templates and app_state can round-trip', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const presetsResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      headers: { cookie },
    })
    const templatesResponse = await fetch(`${server.baseUrl}/api/settings/role-templates`, {
      headers: { cookie },
    })
    const appStateBeforeResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      { headers: { cookie } }
    )

    expect(presetsResponse.status).toBe(200)
    expect(templatesResponse.status).toBe(200)
    expect(appStateBeforeResponse.status).toBe(200)

    const presets = (await presetsResponse.json()) as Array<{
      display_name: string
      id: string
      yolo_args_template: string[] | null
    }>
    const templates = (await templatesResponse.json()) as Array<{
      id: string
      name: string
      role_type: string
    }>
    const appStateBefore = (await appStateBeforeResponse.json()) as {
      key: string
      value: string | null
    }

    expect(presets).toEqual([
      expect.objectContaining({
        id: 'claude',
        display_name: 'Claude Code (CC)',
        yolo_args_template: [
          '--dangerously-skip-permissions',
          '--permission-mode=bypassPermissions',
          '--disallowedTools=Task',
        ],
      }),
      expect.objectContaining({
        id: 'codex',
        display_name: 'Codex',
        yolo_args_template: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
      expect.objectContaining({
        id: 'opencode',
        display_name: 'OpenCode',
        yolo_args_template: [],
      }),
      expect.objectContaining({
        id: 'gemini',
        display_name: 'Gemini',
        yolo_args_template: ['--yolo'],
      }),
    ])
    expect(templates).toEqual([
      expect.objectContaining({
        id: 'orchestrator',
        name: 'Orchestrator',
        role_type: 'orchestrator',
      }),
      expect.objectContaining({ id: 'coder', name: 'Coder', role_type: 'coder' }),
      expect.objectContaining({ id: 'reviewer', name: 'Reviewer', role_type: 'reviewer' }),
      expect.objectContaining({ id: 'tester', name: 'Tester', role_type: 'tester' }),
    ])
    expect(appStateBefore).toEqual({ key: 'active_workspace_id', value: null })

    const updateResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ value: 'ws-123' }),
      }
    )
    expect(updateResponse.status).toBe(204)

    const appStateAfterResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      { headers: { cookie } }
    )
    expect(await appStateAfterResponse.json()).toEqual({
      key: 'active_workspace_id',
      value: 'ws-123',
    })
  })

  test('custom role template CRUD works and builtins are immutable', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const createResponse = await fetch(`${server.baseUrl}/api/settings/role-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Doc Writer',
        role_type: 'custom',
        description: 'Write docs',
        default_command: 'claude',
        default_args: ['docs'],
        default_env: { DOCS: '1' },
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { id: string; name: string }
    expect(created.name).toBe('Doc Writer')

    const updateResponse = await fetch(
      `${server.baseUrl}/api/settings/role-templates/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          name: 'Doc Editor',
          role_type: 'custom',
          description: 'Edit docs',
          default_command: 'claude',
          default_args: ['docs', '--edit'],
          default_env: { DOCS: '2' },
        }),
      }
    )
    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual(
      expect.objectContaining({ id: created.id, name: 'Doc Editor', description: 'Edit docs' })
    )

    const builtinDeleteResponse = await fetch(
      `${server.baseUrl}/api/settings/role-templates/orchestrator`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    )
    expect(builtinDeleteResponse.status).toBe(409)

    const deleteResponse = await fetch(
      `${server.baseUrl}/api/settings/role-templates/${created.id}`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    )
    expect(deleteResponse.status).toBe(204)

    const listResponse = await fetch(`${server.baseUrl}/api/settings/role-templates`, {
      headers: { cookie },
    })
    const templates = (await listResponse.json()) as Array<{ id: string }>
    expect(templates.some((template) => template.id === created.id)).toBe(false)
  })

  test('custom command preset CRUD works and builtins are immutable', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const createResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        display_name: 'Custom Claude',
        command: 'claude',
        args: ['--foo'],
        env: { HELLO: '1' },
        resume_args_template: '--resume {session_id}',
        session_id_capture: {
          source: 'claude_project_jsonl_dir',
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        },
        yolo_args_template: ['--dangerously-skip-permissions'],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { id: string; display_name: string }
    expect(created.display_name).toBe('Custom Claude')

    const updateResponse = await fetch(
      `${server.baseUrl}/api/settings/command-presets/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          display_name: 'Custom Claude 2',
          command: 'claude',
          args: ['--bar'],
          env: { HELLO: '2' },
          resume_args_template: '--continue {session_id}',
          session_id_capture: null,
          yolo_args_template: null,
        }),
      }
    )
    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual(
      expect.objectContaining({ id: created.id, display_name: 'Custom Claude 2' })
    )

    const builtinDeleteResponse = await fetch(
      `${server.baseUrl}/api/settings/command-presets/claude`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    )
    expect(builtinDeleteResponse.status).toBe(409)

    const deleteResponse = await fetch(
      `${server.baseUrl}/api/settings/command-presets/${created.id}`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    )
    expect(deleteResponse.status).toBe(204)

    const listResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      headers: { cookie },
    })
    const presets = (await listResponse.json()) as Array<{ id: string }>
    expect(presets.some((preset) => preset.id === created.id)).toBe(false)
  })

  test('command preset responses expose executable availability', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const createResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        display_name: 'Missing CLI',
        command: '__hive_missing_cli__',
        args: [],
        env: {},
        resume_args_template: null,
        session_id_capture: null,
        yolo_args_template: null,
      }),
    })
    expect(createResponse.status).toBe(201)
    await expect(createResponse.json()).resolves.toEqual(
      expect.objectContaining({ available: false, command: '__hive_missing_cli__' })
    )

    const listResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      headers: { cookie },
    })
    const presets = (await listResponse.json()) as Array<{ available: boolean; command: string }>
    expect(presets.find((preset) => preset.command === '__hive_missing_cli__')).toMatchObject({
      available: false,
    })
  })
})
