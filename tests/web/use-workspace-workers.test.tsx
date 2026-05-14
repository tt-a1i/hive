// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceWorkers', () => {
  test('loads worker summaries for every local workspace id, not only the active workspace', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        a: [
          {
            id: 'wa',
            lastOutputLine: undefined,
            name: 'Alice',
            pendingTaskCount: 1,
            role: 'coder',
            status: 'working',
          },
        ],
        b: [
          {
            id: 'wb',
            lastOutputLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('prunes worker summaries when a workspace is removed from the local list', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      {
        initialProps: { workspaceIds: ['a', 'b'] },
      }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
      expect(result.current[0]).toHaveProperty('b')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        b: [
          {
            id: 'wb',
            lastOutputLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('backs off failed refreshes and does not overlap in-flight worker requests', async () => {
    vi.useFakeTimers()
    let resolveFirstFetch: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(
        json([{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }])
      )
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useWorkspaceWorkers(['a']))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json([]))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await flushPromises()
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
