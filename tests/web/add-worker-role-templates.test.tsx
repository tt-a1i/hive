// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FormEvent } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'
import { AgentCliPicker } from '../../web/src/worker/AddWorkerDialogFields.js'
import { useWorkerComposer } from '../../web/src/worker/useWorkerComposer.js'

const {
  createRoleTemplate,
  deleteRoleTemplate,
  listCommandPresets,
  listRoleTemplates,
  updateRoleTemplate,
} = vi.hoisted(() => ({
  createRoleTemplate: vi.fn(),
  deleteRoleTemplate: vi.fn(),
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
    listCommandPresets: (...args: unknown[]) => listCommandPresets(...args),
    listRoleTemplates: (...args: unknown[]) => listRoleTemplates(...args),
    updateRoleTemplate: (...args: unknown[]) => updateRoleTemplate(...args),
  }
})

const Harness = () => {
  const composer = useWorkerComposer({
    createWorker: async () => ({ error: null, runId: null }),
    open: true,
    workers: [],
  })
  return (
    <ToastProvider>
      <AddWorkerDialog
        commandPresets={composer.commandPresets}
        commandPresetId={composer.commandPresetId}
        creating={composer.creating}
        customRoleName={composer.customRoleName}
        customTemplates={composer.customTemplates}
        onApplyMarketplaceImport={composer.applyMarketplaceImport}
        onClose={() => {}}
        onCustomRoleNameChange={composer.setCustomRoleName}
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
      displayName: 'Claude Code',
      command: 'claude',
      args: [],
      available: true,
    },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Agent CLI picker', () => {
  test('renders built-in CLI logos on the left side of each preset card', () => {
    const onPresetChange = vi.fn()
    const presets = [
      {
        id: 'claude',
        displayName: 'Claude Code (CC)',
        command: 'claude',
        args: [],
        available: true,
      },
      { id: 'codex', displayName: 'Codex', command: 'codex', args: [], available: true },
      { id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: [], available: true },
      { id: 'gemini', displayName: 'Gemini', command: 'gemini', args: [], available: true },
    ]

    render(
      <AgentCliPicker
        commandPresetId="claude"
        commandPresets={presets}
        onPresetChange={onPresetChange}
      />
    )

    for (const preset of presets) {
      const card = screen.getByTestId(`agent-radio-${preset.id}`)
      const logo = within(card).getByTestId('cli-agent-logo')
      expect(logo.getAttribute('data-command-preset')).toBe(preset.id)
    }
    expect(
      within(screen.getByTestId('agent-radio-generic')).getByTestId(
        'agent-radio-generic-generic-icon'
      )
    ).toBeInTheDocument()
  })
})

describe('Add Worker dialog: custom role templates', () => {
  test('template picker stays hidden when a builtin role is selected', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    // Default workerRole is 'coder', so the template picker should not render.
    await waitFor(() => {
      expect(screen.getByTestId('role-card-coder')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('role-template-picker-trigger')).toBeNull()
  })

  test('template picker appears only after selecting the Custom role card', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))

    expect(screen.getByTestId('role-template-picker-trigger')).toBeInTheDocument()
  })

  test('does not refetch role templates when switching role cards', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(listRoleTemplates).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-card-reviewer'))
    fireEvent.click(screen.getByTestId('role-card-custom'))

    expect(listRoleTemplates).toHaveBeenCalledTimes(1)
  })

  test('opening the picker reveals custom templates with search and delete controls', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
      {
        id: 'tpl-tr',
        name: 'Translator',
        roleType: 'custom',
        description: 'Translates content.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))

    // Picker starts closed; opening reveals the search input and options.
    expect(screen.queryByTestId('role-template-picker-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))

    expect(screen.getByTestId('role-template-picker-menu')).toBeInTheDocument()
    expect(screen.getByTestId('role-template-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('role-template-option-tpl-doc')).toBeInTheDocument()
    expect(screen.getByTestId('role-template-option-tpl-tr')).toBeInTheDocument()
    expect(screen.getByTestId('role-template-delete-tpl-doc')).toBeInTheDocument()
    expect(screen.getByTestId('role-template-delete-tpl-tr')).toBeInTheDocument()
  })

  test('typing in the search input filters the visible options', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
      {
        id: 'tpl-tr',
        name: 'Translator',
        roleType: 'custom',
        description: 'Translates content.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))

    fireEvent.change(screen.getByTestId('role-template-search-input'), {
      target: { value: 'trans' },
    })

    expect(screen.queryByTestId('role-template-option-tpl-doc')).toBeNull()
    expect(screen.getByTestId('role-template-option-tpl-tr')).toBeInTheDocument()
  })

  test('selecting an option fills the description textarea and closes the menu', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation in plain language.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
    fireEvent.click(screen.getByTestId('role-template-option-tpl-doc'))

    const textarea = screen.getByTestId('role-instructions-textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Writes documentation in plain language.')
    expect(screen.queryByTestId('role-template-picker-menu')).toBeNull()
    // The trigger should now show the selected template's name.
    expect(screen.getByTestId('role-template-picker-trigger').textContent).toContain('Doc Writer')
  })

  test('clear option resets the selection while staying on Custom', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes documentation.',
        isBuiltin: false,
      },
    ])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
    fireEvent.click(screen.getByTestId('role-template-option-tpl-doc'))
    // re-open and clear
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
    fireEvent.click(screen.getByTestId('role-template-clear'))

    // Still on Custom role; trigger label resets to the placeholder.
    expect(screen.getByTestId('role-card-custom').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('role-template-picker-trigger').textContent).not.toContain(
      'Doc Writer'
    )
  })

  test('deleting a template via the picker calls the API and removes the option', async () => {
    listRoleTemplates.mockResolvedValue([
      {
        id: 'tpl-doc',
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'Writes docs.',
        isBuiltin: false,
      },
    ])
    deleteRoleTemplate.mockResolvedValue(undefined)

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
    fireEvent.click(screen.getByTestId('role-template-delete-tpl-doc'))

    const confirmAction = await screen.findByTestId('confirm-action')
    fireEvent.click(confirmAction)

    await waitFor(() => {
      expect(deleteRoleTemplate).toHaveBeenCalledWith('tpl-doc')
    })
    // Picker stays open; the deleted option is gone.
    await waitFor(() => {
      expect(screen.queryByTestId('role-template-option-tpl-doc')).toBeNull()
    })
  })

  test('picker shows an empty-state hint when no custom templates exist', async () => {
    listRoleTemplates.mockResolvedValue([])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    fireEvent.click(screen.getByTestId('role-template-picker-trigger'))

    expect(screen.getByTestId('role-template-empty-state')).toBeInTheDocument()
  })

  test('save-as-template button shows only on the new-Custom card with description', async () => {
    listRoleTemplates.mockResolvedValue([])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    // initially coder selected; save button hidden
    expect(screen.queryByTestId('role-template-save')).toBeNull()

    fireEvent.click(screen.getByTestId('role-card-custom'))
    const textarea = screen.getByTestId('role-instructions-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'My custom role.' } })

    expect(screen.getByTestId('role-template-save')).toBeInTheDocument()
  })

  test('save-as-template flow posts and auto-selects the new template', async () => {
    listRoleTemplates.mockResolvedValue([])
    createRoleTemplate.mockResolvedValue({
      id: 'tpl-new',
      name: 'Doc Writer',
      roleType: 'custom',
      description: 'My custom role.',
      isBuiltin: false,
    })

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    const textarea = screen.getByTestId('role-instructions-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'My custom role.' } })

    fireEvent.click(screen.getByTestId('role-template-save'))
    const nameInput = await screen.findByTestId('role-template-save-name')
    fireEvent.change(nameInput, { target: { value: 'Doc Writer' } })
    fireEvent.click(screen.getByTestId('role-template-save-confirm'))

    await waitFor(() => {
      expect(createRoleTemplate).toHaveBeenCalledWith({
        name: 'Doc Writer',
        roleType: 'custom',
        description: 'My custom role.',
      })
    })
    // Trigger label updates; save button hides because a template is now selected.
    await waitFor(() => {
      expect(screen.getByTestId('role-template-picker-trigger').textContent).toContain('Doc Writer')
    })
    expect(screen.queryByTestId('role-template-save')).toBeNull()
  })

  test('cancelling the inline save prompt does not call createRoleTemplate', async () => {
    listRoleTemplates.mockResolvedValue([])

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByTestId('role-card-custom')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('role-card-custom'))
    const textarea = screen.getByTestId('role-instructions-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'My custom role.' } })

    fireEvent.click(screen.getByTestId('role-template-save'))
    await screen.findByTestId('role-template-save-name')
    fireEvent.click(screen.getByTestId('role-template-save-cancel'))

    expect(createRoleTemplate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('role-template-save-name')).toBeNull()
    expect(screen.getByTestId('role-template-save')).toBeInTheDocument()
  })
})
