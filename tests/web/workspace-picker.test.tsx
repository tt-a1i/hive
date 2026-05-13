// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { FsBrowseResponse, FsProbeResponse, PickFolderResponse } from '../../web/src/api.js'
import { AddWorkspaceDialog } from '../../web/src/workspace/AddWorkspaceDialog.js'

/**
 * Pure-UI tests for the two-stage workspace picker. `fetch` is stubbed with
 * deterministic responses — no real server. Each test wires a specific
 * `/api/fs/pick-folder` payload so we exercise the native-picker contract
 * (canceled / unsupported / supported+path) from the UI side.
 */

const ROOT = '/sandbox'
const PICKED = `${ROOT}/alpha`
const OTHER = `${ROOT}/beta`

const sandboxProbe: FsProbeResponse = {
  current_branch: 'main',
  exists: true,
  is_dir: true,
  is_git_repository: true,
  ok: true,
  path: PICKED,
  suggested_name: 'alpha',
}

const rootBrowse: FsBrowseResponse = {
  current_path: ROOT,
  root_path: ROOT,
  parent_path: null,
  entries: [
    { is_dir: true, is_git_repository: true, name: 'alpha', path: PICKED },
    { is_dir: true, is_git_repository: false, name: 'beta', path: OTHER },
  ],
  error: null,
  ok: true,
}

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

const commandPresets = [
  { args: [], command: 'claude', display_name: 'Claude Code (CC)', id: 'claude' },
  { args: [], command: 'codex', display_name: 'Codex', id: 'codex' },
]

type PickHandler = () => PickFolderResponse

const stubFetch = (pick: PickHandler, browse?: FsBrowseResponse) => {
  const calls: Array<{ method: string; url: string }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const u = new URL(url, 'http://127.0.0.1')
    const method = init?.method ?? 'GET'
    calls.push({ method, url: u.pathname + u.search })
    if (u.pathname === '/api/fs/pick-folder' && method === 'POST') {
      return json(pick())
    }
    if (u.pathname === '/api/fs/browse') {
      return json(browse ?? rootBrowse)
    }
    if (u.pathname === '/api/fs/probe') {
      const q = u.searchParams.get('path') ?? ''
      return json({ ...sandboxProbe, path: q, suggested_name: q.split('/').pop() ?? '' })
    }
    if (u.pathname === '/api/settings/command-presets') {
      return json(commandPresets)
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  return calls
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AddWorkspaceDialog — native folder picker default flow', () => {
  test('native picker loading surface is centered in the viewport while the request is pending', async () => {
    let resolvePick!: (value: PickFolderResponse) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const u = new URL(url, 'http://127.0.0.1')
      if (u.pathname === '/api/settings/command-presets') return json(commandPresets)
      if (u.pathname === '/api/fs/pick-folder') {
        return json(
          await new Promise<PickFolderResponse>((resolve) => {
            resolvePick = resolve
          })
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={() => {}} />)

    const picking = await screen.findByTestId('add-workspace-picking')
    expect(picking).toHaveClass('fixed', 'inset-0', 'items-center', 'justify-center')
    expect(within(picking).getByTestId('add-workspace-picking-panel')).toHaveTextContent(
      'Opening system folder picker'
    )

    resolvePick({ canceled: true, error: null, path: null, probe: null, supported: true })
  })

  test('trigger bump fires POST /api/fs/pick-folder then opens the compact ConfirmDialog', async () => {
    const calls = stubFetch(() => ({
      canceled: false,
      error: null,
      path: PICKED,
      probe: sandboxProbe,
      supported: true,
    }))
    const onCreate = vi.fn()

    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={onCreate} />)

    // Compact confirm dialog is shown, not the server-browse dialog.
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    expect(screen.queryByTestId('add-workspace-dialog')).toBeNull() // server-browse is absent
    expect(within(confirm).getByTestId('confirm-workspace-path')).toHaveValue(PICKED)
    expect((within(confirm).getByTestId('confirm-workspace-name') as HTMLInputElement).value).toBe(
      'alpha'
    )
    expect(within(confirm).getByTestId('confirm-workspace-git-badge').textContent).toContain('main')

    expect(calls).toContainEqual({ method: 'POST', url: '/api/fs/pick-folder' })
  })

  test('canceled=true closes silently and fires onClose — no dialog left behind', async () => {
    stubFetch(() => ({
      canceled: true,
      error: null,
      path: null,
      probe: null,
      supported: true,
    }))
    const onClose = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={onClose} onCreate={() => {}} />)

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
      expect(screen.queryByTestId('add-workspace-picking')).toBeNull()
      expect(screen.queryByTestId('add-workspace-error')).toBeNull()
    })
    expect(onClose).toHaveBeenCalled()
  })

  test('canceled=true with an error keeps the flow open with paste fallback', async () => {
    stubFetch(() => ({
      canceled: true,
      error: 'Folder picker timed out.',
      path: null,
      probe: null,
      supported: true,
    }))
    const onClose = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={onClose} onCreate={() => {}} />)

    const err = await screen.findByTestId('add-workspace-error')
    expect(within(err).getByText(/timed out/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('supported=false opens ConfirmDialog with paste-path expanded by default', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: null,
      probe: null,
      supported: false,
    }))
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={() => {}} />)

    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    // Paste-path input is visible without having to toggle — this is the fallback.
    expect(within(confirm).getByTestId('confirm-workspace-paste-path')).toBeInTheDocument()
  })

  test('probe.ok=false surfaces the error dialog with "Paste path instead" fallback', async () => {
    stubFetch(() => ({
      canceled: false,
      error: 'Selected path is outside the Hive browse sandbox or is not a directory.',
      path: '/outside',
      probe: { ...sandboxProbe, ok: false, is_dir: false, path: '/outside' },
      supported: true,
    }))
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={() => {}} />)

    const err = await screen.findByTestId('add-workspace-error')
    expect(within(err).getByText(/outside the Hive browse sandbox/)).toBeInTheDocument()

    // Clicking the paste-path recovery action opens the compact confirm with
    // the paste-path fallback expanded (same state as supported=false).
    fireEvent.click(within(err).getByRole('button', { name: /Paste path instead/ }))
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    expect(within(confirm).getByTestId('confirm-workspace-paste-path')).toBeInTheDocument()
  })

  test('Confirm dialog → Create fires onCreate with name + probe path', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: PICKED,
      probe: sandboxProbe,
      supported: true,
    }))
    const onCreate = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={onCreate} />)

    await screen.findByTestId('confirm-workspace-dialog')
    const nameInput = screen.getByTestId('confirm-workspace-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('confirm-workspace-create'))

    expect(onCreate).toHaveBeenCalledWith({
      commandPresetId: 'claude',
      name: 'renamed',
      path: PICKED,
    })
  })

  test('Confirm dialog lets the user choose the orchestrator CLI preset', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: PICKED,
      probe: sandboxProbe,
      supported: true,
    }))
    const onCreate = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={onCreate} />)

    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.change(within(confirm).getByTestId('workspace-command-preset'), {
      target: { value: 'codex' },
    })
    fireEvent.click(within(confirm).getByTestId('confirm-workspace-create'))

    expect(onCreate).toHaveBeenCalledWith({
      commandPresetId: 'codex',
      name: 'alpha',
      path: PICKED,
    })
  })

  test('paste-path fallback supplies the path when user did not pick a folder', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: null,
      probe: null,
      supported: false,
    }))
    const onCreate = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={onCreate} />)

    await screen.findByTestId('confirm-workspace-dialog')
    const pasteInput = screen.getByTestId('confirm-workspace-paste-path') as HTMLInputElement
    fireEvent.change(pasteInput, { target: { value: '/abs/path/here' } })
    fireEvent.change(screen.getByTestId('confirm-workspace-name'), { target: { value: 'custom' } })

    fireEvent.click(screen.getByTestId('confirm-workspace-create'))
    expect(onCreate).toHaveBeenCalledWith({
      commandPresetId: 'claude',
      name: 'custom',
      path: '/abs/path/here',
    })
  })
})

describe('AddWorkspaceDialog — server-browse Advanced mode', () => {
  test('▸ Advanced: browse server filesystem swaps to the ServerBrowseDialog', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: PICKED,
      probe: sandboxProbe,
      supported: true,
    }))
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={() => {}} />)

    await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.click(screen.getByTestId('confirm-workspace-browse-toggle'))

    // Server browse dialog (previously the default) appears; compact confirm is gone.
    await screen.findByTestId('add-workspace-dialog')
    expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
    expect(screen.getByTestId('fs-breadcrumb')).toBeInTheDocument()
    expect(await screen.findByTestId('fs-entry-alpha')).toBeInTheDocument()
  })

  test('ServerBrowseDialog still creates via path + name (Advanced branch)', async () => {
    stubFetch(() => ({
      canceled: false,
      error: null,
      path: PICKED,
      probe: sandboxProbe,
      supported: true,
    }))
    const onCreate = vi.fn()
    render(<AddWorkspaceDialog trigger={1} onClose={() => {}} onCreate={onCreate} />)

    await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.click(screen.getByTestId('confirm-workspace-browse-toggle'))

    const entry = await screen.findByTestId('fs-entry-alpha')
    fireEvent.click(entry)
    await waitFor(() => {
      expect(screen.getByTestId('fs-preview-path').textContent).toContain('alpha')
    })
    fireEvent.change(screen.getByTestId('fs-preview-name-input'), { target: { value: 'Alpha' } })
    fireEvent.click(screen.getByTestId('add-workspace-create'))

    expect(onCreate).toHaveBeenCalledWith({
      commandPresetId: 'claude',
      name: 'Alpha',
      path: PICKED,
    })
  })
})
