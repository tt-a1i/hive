import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createRoleTemplate,
  deleteRoleTemplate,
  listRoleTemplates,
  updateRoleTemplate,
} from '../../web/src/api.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const makePayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  name: 'Doc Writer',
  role_type: 'custom',
  description: 'Writes documentation.',
  default_command: '',
  default_args: [],
  default_env: {},
  is_builtin: false,
  ...overrides,
})

describe('role-templates api client', () => {
  test('listRoleTemplates surfaces isBuiltin so the UI can gate edit/delete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              makePayload({ id: 'builtin-coder', name: 'Coder', is_builtin: true }),
              makePayload({ id: 'tpl-doc', name: 'Doc Writer', is_builtin: false }),
            ]),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          )
      )
    )

    const templates = await listRoleTemplates()
    expect(templates.map((t) => ({ id: t.id, isBuiltin: t.isBuiltin }))).toEqual([
      { id: 'builtin-coder', isBuiltin: true },
      { id: 'tpl-doc', isBuiltin: false },
    ])
  })

  test('createRoleTemplate POSTs JSON and returns the new template', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(makePayload({ id: 'tpl-new', name: 'Doc Writer' })), {
          headers: { 'content-type': 'application/json' },
          status: 201,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const created = await createRoleTemplate({
      name: 'Doc Writer',
      roleType: 'custom',
      description: 'Writes docs.',
    })

    expect(created).toEqual({
      description: 'Writes documentation.',
      id: 'tpl-new',
      isBuiltin: false,
      name: 'Doc Writer',
      roleType: 'custom',
    })

    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('/api/settings/role-templates')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Doc Writer',
      role_type: 'custom',
      description: 'Writes docs.',
      default_command: '',
      default_args: [],
      default_env: {},
    })
  })

  test('updateRoleTemplate PATCHes the id-specific path', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(makePayload({ id: 'tpl-1', name: 'Renamed' })), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const updated = await updateRoleTemplate('tpl-1', {
      name: 'Renamed',
      roleType: 'custom',
      description: 'Updated description.',
    })

    expect(updated.id).toBe('tpl-1')
    expect(updated.name).toBe('Renamed')

    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('/api/settings/role-templates/tpl-1')
    expect(init?.method).toBe('PATCH')
  })

  test('deleteRoleTemplate DELETEs and resolves on 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteRoleTemplate('tpl-1')).resolves.toBeUndefined()

    expect(fetchMock.mock.calls.length).toBe(1)
    const [url2, init2] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url2).toBe('/api/settings/role-templates/tpl-1')
    expect(init2?.method).toBe('DELETE')
  })

  test('createRoleTemplate surfaces server JSON error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Role template name is required' }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          })
      )
    )

    await expect(
      createRoleTemplate({ name: '', roleType: 'custom', description: 'x' })
    ).rejects.toThrow('Role template name is required')
  })

  test('deleteRoleTemplate surfaces conflict when caller tries to delete a builtin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'Builtin role template is read-only: builtin-coder' }),
            { headers: { 'content-type': 'application/json' }, status: 409 }
          )
      )
    )

    await expect(deleteRoleTemplate('builtin-coder')).rejects.toThrow(
      'Builtin role template is read-only: builtin-coder'
    )
  })
})
