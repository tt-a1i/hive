// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { AppProviders } from '../../web/src/AppProviders.js'
import { Topbar } from '../../web/src/layout/Topbar.js'
import { SettingsMenu } from '../../web/src/settings/SettingsMenu.js'

const putCalls: Array<{ enabled: boolean }> = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Stub the network (not the api module — too many components import it) so the
// real apiFetch path runs against canned responses.
const stubFetch = (initialEnabled: boolean, putOk = true) => {
  let enabled = initialEnabled
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.includes('/api/settings/workflow-feature')) {
      if (method === 'PUT') {
        if (!putOk) return json({ error: 'boom' }, 500)
        enabled = (JSON.parse(String(init?.body ?? '{}')) as { enabled: boolean }).enabled
        putCalls.push({ enabled })
      }
      return json({ enabled })
    }
    return json({})
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  putCalls.length = 0
})

const VERSION_INFO = {
  canRunHiveUpdate: true,
  currentVersion: '1.4.4',
  installHint: '',
  installSource: 'npm-global',
  latestVersion: '1.4.4',
  packageName: '@tt-a1i/hive',
  releaseUrl: '',
  updateNote: '',
  updateAvailable: false,
}

test('settings menu toggles the experimental workflow feature on and persists it', async () => {
  stubFetch(false)
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )

  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const checkbox = await screen.findByRole('switch', { name: /workflow/i })
  await waitFor(() => expect(checkbox).not.toBeDisabled())
  expect(checkbox).not.toBeChecked()

  fireEvent.click(checkbox)

  await waitFor(() => expect(putCalls).toContainEqual({ enabled: true }))
  await waitFor(() => expect(checkbox).toBeChecked())
})

test('settings menu surfaces an error when saving the toggle fails', async () => {
  stubFetch(false, false) // GET ok (disabled), PUT 500s
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )

  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const checkbox = await screen.findByRole('switch', { name: /workflow/i })
  await waitFor(() => expect(checkbox).not.toBeDisabled())

  fireEvent.click(checkbox)

  // The user must see a failure, not a silent no-op that looks saved.
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(putCalls).toEqual([])
  expect(checkbox).not.toBeChecked()
})

test('settings menu reflects an already-enabled feature on open', async () => {
  stubFetch(true)
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )

  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const checkbox = await screen.findByRole('switch', { name: /workflow/i })
  await waitFor(() => expect(checkbox).toBeChecked())
})

test('topbar hides the Workflows button when no toggle is wired (the feature-off path)', () => {
  // AppInner passes onToggleWorkflows=undefined while workflows are disabled,
  // and the topbar renders the button only when a toggle is provided.
  stubFetch(false)
  render(
    <AppProviders>
      <Topbar version="1.4.4" versionInfo={VERSION_INFO} />
    </AppProviders>
  )
  expect(screen.queryByTestId('topbar-workflows')).toBeNull()
})

test('topbar shows the Workflows button when a toggle is wired (the feature-on path)', () => {
  stubFetch(true)
  render(
    <AppProviders>
      <Topbar version="1.4.4" versionInfo={VERSION_INFO} onToggleWorkflows={() => {}} />
    </AppProviders>
  )
  expect(screen.getByTestId('topbar-workflows')).toBeInTheDocument()
})
