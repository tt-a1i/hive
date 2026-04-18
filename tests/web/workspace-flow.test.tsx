// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('workspace flow', () => {
  test('can create a workspace from the empty state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ws-1',
          name: 'Alpha',
          path: '/tmp/hive-alpha',
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('No workspaces yet')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Workspace Name'), {
      target: { value: 'Alpha' },
    })
    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/tmp/hive-alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }))

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('/tmp/hive-alpha')).toBeInTheDocument()
      expect(screen.getByText('Orchestrator')).toBeInTheDocument()
      expect(screen.getByText('Worker cards coming next')).toBeInTheDocument()
    })

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-alpha' }),
    })
  })

  test('can switch active workspace from the sidebar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'ws-1', name: 'Alpha', path: '/tmp/hive-alpha' },
          { id: 'ws-2', name: 'Beta', path: '/tmp/hive-beta' },
        ],
      })
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('Beta')).toBeInTheDocument()
    })

    expect(screen.getByText('/tmp/hive-alpha')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))

    await waitFor(() => {
      expect(screen.getByText('/tmp/hive-beta')).toBeInTheDocument()
    })
  })
})
