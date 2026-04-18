// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app shell', () => {
  test('renders hive title and empty workspace form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    )

    render(<App />)

    expect(screen.getByText('Hive')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('No workspaces yet')).toBeInTheDocument()
    })

    expect(screen.getByLabelText('Workspace Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Workspace Path')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument()
  })

  test('renders workspace sidebar items from api', async () => {
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
  })
})
