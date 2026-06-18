// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { FormEvent } from 'react'
import type { WorkerRole } from '../../src/shared/types.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'

const baseProps = {
  commandPresets: [{ id: 'claude', displayName: 'Claude Code', command: 'claude', args: [], available: true }],
  commandPresetId: 'claude',
  creating: false,
  customRoleName: 'Helper',
  customTemplates: [],
  onClose: vi.fn(),
  onCustomRoleNameChange: vi.fn(),
  onDeleteTemplate: vi.fn(),
  onNameChange: vi.fn(),
  onPresetChange: vi.fn(),
  onRandomName: vi.fn(),
  onRoleChange: vi.fn() as (v: WorkerRole) => void,
  onRoleDescriptionChange: vi.fn(),
  onRoleDescriptionReset: vi.fn(),
  onSaveAsTemplate: vi.fn(),
  onStartupCommandChange: vi.fn(),
  onSubmit: vi.fn((e: FormEvent<HTMLFormElement>) => e.preventDefault()),
  onTemplateChange: vi.fn(),
  roleDescription: 'A helpful worker',
  roleDescriptionDefault: 'A helpful worker',
  selectedTemplateId: null,
  startupCommand: '',
  templateBusy: false,
  workerName: 'test-worker',
  workerRole: 'coder' as WorkerRole,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AddWorkerDialog: save-as-template validation', () => {
  test('blocks submit with empty template name when save-as-template mode is active', () => {
    render(
      <ToastProvider>
        <AddWorkerDialog {...baseProps} />
      </ToastProvider>
    )

    const toggleBtn = screen.getByTestId('save-as-template-toggle')
    fireEvent.click(toggleBtn)

    const submitBtn = screen.getByTestId('add-worker-submit')
    fireEvent.click(submitBtn)

    expect(baseProps.onSaveAsTemplate).not.toHaveBeenCalled()
    expect(baseProps.onSubmit).not.toHaveBeenCalled()
  })

  test('blocks submit with whitespace-only template name', () => {
    render(
      <ToastProvider>
        <AddWorkerDialog {...baseProps} />
      </ToastProvider>
    )

    const toggleBtn = screen.getByTestId('save-as-template-toggle')
    fireEvent.click(toggleBtn)

    const nameInput = screen.getByTestId('save-template-name-input')
    fireEvent.change(nameInput, { target: { value: '   ' } })

    const submitBtn = screen.getByTestId('add-worker-submit')
    fireEvent.click(submitBtn)

    expect(baseProps.onSaveAsTemplate).not.toHaveBeenCalled()
  })

  test('allows submit with valid template name', () => {
    render(
      <ToastProvider>
        <AddWorkerDialog {...baseProps} />
      </ToastProvider>
    )

    const toggleBtn = screen.getByTestId('save-as-template-toggle')
    fireEvent.click(toggleBtn)

    const nameInput = screen.getByTestId('save-template-name-input')
    fireEvent.change(nameInput, { target: { value: 'My Template' } })

    const submitBtn = screen.getByTestId('add-worker-submit')
    fireEvent.click(submitBtn)

    expect(baseProps.onSaveAsTemplate).toHaveBeenCalledWith('My Template')
  })
})
