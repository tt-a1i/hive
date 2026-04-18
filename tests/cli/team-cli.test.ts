import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('team cli', () => {
  test('fails when required hive environment variables are missing', async () => {
    await expect(runTeamCommand(['list'])).rejects.toThrow(
      'Missing required Hive environment variables'
    )
  })

  test('team list fetches worker list and prints one-line json', async () => {
    process.env.HIVE_PORT = '4123'
    process.env.HIVE_PROJECT_ID = 'project-1'
    process.env.HIVE_AGENT_ID = 'agent-1'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'alice', name: 'Alice', role: 'coder', status: 'idle', pendingTaskCount: 0 },
      ],
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)

    await runTeamCommand(['list'])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4123/api/workspaces/project-1/team',
      expect.objectContaining({ method: 'GET' })
    )
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify([
        { id: 'alice', name: 'Alice', role: 'coder', status: 'idle', pendingTaskCount: 0 },
      ])
    )
  })

  test('team send posts dispatch payload', async () => {
    process.env.HIVE_PORT = '4123'
    process.env.HIVE_PROJECT_ID = 'project-1'
    process.env.HIVE_AGENT_ID = 'orch-1'

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await runTeamCommand(['send', 'alice', 'Implement login'])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4123/api/team/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: 'project-1',
          fromAgentId: 'orch-1',
          to: 'alice',
          text: 'Implement login',
        }),
      })
    )
  })

  test('team report posts report payload', async () => {
    process.env.HIVE_PORT = '4123'
    process.env.HIVE_PROJECT_ID = 'project-1'
    process.env.HIVE_AGENT_ID = 'worker-1'

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await runTeamCommand(['report', 'Done', '--success', '--artifact', 'src/auth.ts'])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4123/api/team/report',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: 'project-1',
          fromAgentId: 'worker-1',
          result: 'Done',
          status: 'success',
          artifacts: ['src/auth.ts'],
        }),
      })
    )
  })
})
