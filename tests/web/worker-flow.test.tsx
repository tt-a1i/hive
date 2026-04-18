// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worker flow', () => {
  test('can create a worker for the active workspace', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'ws-1', name: 'Alpha', path: '/tmp/hive-alpha' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'worker-1',
          workspaceId: 'ws-1',
          name: 'Alice',
          role: 'coder',
          status: 'idle',
          pendingTaskCount: 0,
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('/tmp/hive-alpha')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Worker Name'), {
      target: { value: 'Alice' },
    })
    fireEvent.change(screen.getByLabelText('Worker Role'), {
      target: { value: 'coder' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add Worker' }))

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('coder')).toBeInTheDocument()
      expect(screen.getByText('idle')).toBeInTheDocument()
    })

    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/workspaces/ws-1/workers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })
  })
})
