// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FormEvent } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'
import { useWorkerComposer } from '../../web/src/worker/useWorkerComposer.js'

const MARKETPLACE_DRAWER_TIMEOUT_MS = 5_000

const {
  createRoleTemplate,
  deleteRoleTemplate,
  fetchMarketplaceAgent,
  fetchMarketplaceManifest,
  listCommandPresets,
  listRoleTemplates,
  updateRoleTemplate,
} = vi.hoisted(() => ({
  createRoleTemplate: vi.fn(),
  deleteRoleTemplate: vi.fn(),
  fetchMarketplaceAgent: vi.fn(),
  fetchMarketplaceManifest: vi.fn(),
  listCommandPresets: vi.fn(),
  listRoleTemplates: vi.fn(),
  updateRoleTemplate: vi.fn(),
}))

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    createRoleTemplate: (...args: unknown[]) => createRoleTemplate(...args),
    deleteRoleTemplate: (...args: unknown[]) => deleteRoleTemplate(...args),
    fetchMarketplaceAgent: (...args: unknown[]) => fetchMarketplaceAgent(...args),
    fetchMarketplaceManifest: (...args: unknown[]) => fetchMarketplaceManifest(...args),
    listCommandPresets: (...args: unknown[]) => listCommandPresets(...args),
    listRoleTemplates: (...args: unknown[]) => listRoleTemplates(...args),
    updateRoleTemplate: (...args: unknown[]) => updateRoleTemplate(...args),
  }
})

const Harness = ({ onSubmitCapture }: { onSubmitCapture?: (snapshot: unknown) => void }) => {
  const composer = useWorkerComposer({
    createWorker: async () => ({ error: null, runId: null }),
    open: true,
    workers: [],
  })

  return (
    <ToastProvider>
      <Toaster />
      <AddWorkerDialog
        commandPresets={composer.commandPresets}
        commandPresetId={composer.commandPresetId}
        creating={composer.creating}
        customTemplates={composer.customTemplates}
        onApplyMarketplaceImport={composer.applyMarketplaceImport}
        onClose={() => {}}
        onDeleteTemplate={composer.deleteTemplate}
        onNameChange={composer.setWorkerName}
        onPresetChange={composer.setCommandPresetId}
        onRandomName={composer.randomizeWorkerName}
        onRoleChange={composer.setWorkerRole}
        onRoleDescriptionChange={composer.setRoleDescription}
        onRoleDescriptionReset={composer.resetRoleDescription}
        onSaveAsTemplate={composer.saveAsTemplate}
        onStartupCommandChange={composer.setStartupCommand}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          onSubmitCapture?.({
            workerName: composer.workerName,
            workerRole: composer.workerRole,
            roleDescription: composer.roleDescription,
            selectedTemplateId: composer.selectedTemplateId,
          })
        }}
        onTemplateChange={composer.selectTemplate}
        roleDescription={composer.roleDescription}
        roleDescriptionDefault={composer.roleDescriptionDefault}
        selectedTemplateId={composer.selectedTemplateId}
        startupCommand={composer.startupCommand}
        templateBusy={composer.templateBusy}
        workerName={composer.workerName}
        workerRole={composer.workerRole}
      />
    </ToastProvider>
  )
}

beforeEach(() => {
  listCommandPresets.mockResolvedValue([
    {
      id: 'claude',
      display_name: 'Claude Code',
      command: 'claude',
      args: [],
      env: {},
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: null,
      is_builtin: true,
      available: true,
    },
  ])
  listRoleTemplates.mockResolvedValue([])
  fetchMarketplaceManifest.mockResolvedValue({
    source: { repo: 'msitarzewski/agency-agents', commit: 'abc', fetched_at: 'x' },
    language: 'en',
    categories: ['engineering'],
    agents: [
      {
        path: 'engineering/code-reviewer.md',
        category: 'engineering',
        name: 'Code Reviewer',
        description: 'Reviews code',
        emoji: '👁️',
        color: 'purple',
      },
    ],
  })
  fetchMarketplaceAgent.mockResolvedValue({
    path: 'engineering/code-reviewer.md',
    frontmatter: { name: 'Code Reviewer' },
    body: 'You review every PR.\n\nFocus on correctness.',
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  createRoleTemplate.mockReset()
  deleteRoleTemplate.mockReset()
  fetchMarketplaceAgent.mockReset()
  fetchMarketplaceManifest.mockReset()
  listCommandPresets.mockReset()
  listRoleTemplates.mockReset()
  updateRoleTemplate.mockReset()
})

describe('AddWorkerDialog marketplace integration', () => {
  test('does not load the marketplace manifest until the drawer is opened', async () => {
    render(<Harness />)

    await waitFor(() => expect(listCommandPresets).toHaveBeenCalled())
    expect(fetchMarketplaceManifest).not.toHaveBeenCalled()
    expect(screen.queryByTestId('marketplace-content')).not.toBeInTheDocument()
  })

  test('clicking Browse marketplace opens the drawer', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('open-marketplace'))
    expect(
      await screen.findByTestId('marketplace-content', undefined, {
        timeout: MARKETPLACE_DRAWER_TIMEOUT_MS,
      })
    ).toBeInTheDocument()
  })

  test('importing an agent shows a success toast with the agent name', async () => {
    render(<Harness />)

    fireEvent.click(screen.getByTestId('open-marketplace'))
    expect(
      await screen.findByText('Code Reviewer', undefined, {
        timeout: MARKETPLACE_DRAWER_TIMEOUT_MS,
      })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('Code Reviewer'))
    const importButton = await screen.findByTestId('marketplace-import-button')
    await waitFor(() => expect(importButton).not.toBeDisabled())
    fireEvent.click(importButton)

    const toast = await screen.findByTestId('toast')
    expect(toast.textContent ?? '').toContain('Code Reviewer')
  })

  test('importing an agent fills the AddWorker form with name + description and flips role to custom', async () => {
    const submitCapture = vi.fn()
    render(<Harness onSubmitCapture={submitCapture} />)

    fireEvent.click(screen.getByTestId('open-marketplace'))
    expect(
      await screen.findByText('Code Reviewer', undefined, {
        timeout: MARKETPLACE_DRAWER_TIMEOUT_MS,
      })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByText('Code Reviewer'))
    const importButton = await screen.findByTestId('marketplace-import-button')
    await waitFor(() => expect(importButton).not.toBeDisabled())
    fireEvent.click(importButton)

    // Drawer is closed after import.
    await waitFor(() => {
      expect(screen.queryByTestId('marketplace-content')).not.toBeInTheDocument()
    })

    // The AddWorker form should now show the imported name + description and
    // have flipped to the Custom role. We assert by submitting and inspecting
    // the composer snapshot, which captures the state visible on save.
    const submitButton = screen.getByTestId('add-worker-submit')
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(submitCapture).toHaveBeenCalled()
    })
    const snapshot = submitCapture.mock.calls[0][0] as {
      workerName: string
      workerRole: string
      roleDescription: string
      selectedTemplateId: string | null
    }
    expect(snapshot.workerName).toBe('Code Reviewer')
    expect(snapshot.workerRole).toBe('custom')
    expect(snapshot.roleDescription).toContain('You review every PR.')
    expect(snapshot.roleDescription).toContain('Focus on correctness.')
    expect(snapshot.selectedTemplateId).toBeNull()
  })
})
