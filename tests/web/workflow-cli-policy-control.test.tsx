// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../../web/src/api.js', () => ({
  getWorkflowCliPolicy: vi.fn(),
  saveWorkflowCliPolicy: vi.fn(),
}))

import { getWorkflowCliPolicy, saveWorkflowCliPolicy } from '../../web/src/api.js'
import { WorkflowCliPolicyControl } from '../../web/src/workflows/WorkflowCliPolicyControl.js'

const getPolicy = vi.mocked(getWorkflowCliPolicy)
const savePolicy = vi.mocked(saveWorkflowCliPolicy)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('loads the policy, lets the user pick default + allowlist, and saves the selection', async () => {
  getPolicy.mockResolvedValue({
    default: 'claude',
    allowed: ['claude', 'codex', 'opencode', 'gemini', 'hermes'],
    supported: ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'kimi'],
  })
  savePolicy.mockResolvedValue({
    default: 'codex',
    allowed: ['codex'],
    supported: ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'kimi'],
  })

  render(<WorkflowCliPolicyControl />)

  // Loaded state: default is claude (the stored default).
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Claude Code' })).toBeChecked())
  expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Codex' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Hermes' })).toBeChecked()
  expect(
    screen.getByRole('radio', { name: 'Kimi Code' }).closest('label')?.querySelector('img')
  ).toHaveAttribute('src', '/cli-icons/kimi.png')

  // Make Codex the default, then drop Claude Code from the allowlist.
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }))

  expect(screen.getByRole('checkbox', { name: 'Claude Code' })).not.toBeChecked()
  expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked()

  fireEvent.click(screen.getByRole('button', { name: /save/i }))

  await waitFor(() =>
    expect(savePolicy).toHaveBeenCalledWith({
      default: 'codex',
      allowed: ['codex', 'opencode', 'gemini', 'hermes'],
    })
  )
  await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
})

test('blocks saving when no CLI is allowed', async () => {
  getPolicy.mockResolvedValue({
    default: 'claude',
    allowed: ['claude'],
    supported: ['claude', 'codex', 'opencode', 'gemini', 'hermes'],
  })

  render(<WorkflowCliPolicyControl />)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toBeChecked())

  // Uncheck the only allowed CLI — Save must be disabled and nothing is sent.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }))

  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  expect(savePolicy).not.toHaveBeenCalled()
})
