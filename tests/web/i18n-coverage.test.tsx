// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const groups: Record<string, TranslationKey[]> = {
  'connect-machines': [
    'connect.machines.heading',
    'connect.machines.empty',
    'connect.machines.offline',
    'connect.machines.select',
  ],
  'connect-view': [
    'connect.login.heading',
    'connect.login.subtitle',
    'connect.login.github',
    'connect.login.google',
    'connect.pair.guideHeading',
    'connect.pair.guideStep1',
    'connect.pair.guideStep2',
    'connect.pair.guideStep3',
    'connect.pair.qrLabel',
    'connect.pair.sasPrompt',
    'connect.error.selectFailed',
    'connect.error.invalidCode',
    'openWorkspace.opened',
    'workspace.add.manualHint',
  ],
  'mobile-adapt': [
    'common.stop',
    'common.restart',
    'worker.stopAria',
    'worker.restartAria',
    'mobile.workspaces.switch',
  ],
  'mobile-shell': [
    'mobile.nav.team',
    'mobile.nav.tasks',
    'mobile.nav.more',
    'mobile.section.workspaces',
    'mobile.section.settings',
    'mobile.section.workflows',
    'mobile.section.devices',
    'mobile.section.about',
    'mobile.section.demo',
    'mobile.tasks.noWorkspaceTitle',
    'mobile.tasks.noWorkspaceDesc',
    'mobile.reconnect.reconnecting',
    'mobile.reconnect.disconnected',
    'mobile.reconnect.retry',
  ],
  pairing: [
    'pairing.connecting',
    'pairing.handshaking',
    'pairing.sasPrompt',
    'pairing.awaitingConfirm',
    'pairing.paired',
    'pairing.failed.rejected',
    'pairing.failed.expired',
    'pairing.failed.socket',
    'pairing.failed.mintForbidden',
    'pairing.failed.version',
    'pairing.cancel',
  ],
  remote: [
    'remote.section',
    'remote.enable.label',
    'remote.enable.description',
    'remote.status.linked',
    'remote.status.notLinked',
    'remote.status.connecting',
    'remote.status.reconnecting',
    'remote.status.revoked',
    'remote.status.connected',
    'remote.status.disconnected',
    'remote.addDevice',
    'remote.qr.title',
    'remote.qr.instructions',
    'remote.qr.expiresIn',
    'remote.qr.expired',
    'remote.qr.cancel',
    'remote.qr.regenerate',
    'remote.qr.startFailed',
    'remote.confirm.title',
    'remote.confirm.description',
    'remote.confirm.sasLabel',
    'remote.confirm.warning',
    'remote.confirm.confirm',
    'remote.confirm.reject',
    'remote.confirm.confirming',
    'remote.confirm.paired',
    'remote.confirm.rejected',
    'remote.confirm.expired',
    'remote.confirm.failed',
    'remote.devices.heading',
    'remote.devices.empty',
    'remote.devices.lastActive',
    'remote.devices.neverActive',
    'remote.devices.revoke',
    'remote.devices.revokeAria',
    'remote.devices.revokeConfirm',
    'remote.devices.revokeTitle',
    'remote.devices.revoked',
    'remote.devices.revokeFailed',
    'remote.devices.loadFailed',
    'remote.audit.show',
    'remote.audit.hide',
    'remote.audit.heading',
    'remote.audit.empty',
    'remote.audit.result.ok',
    'remote.audit.result.rejected',
    'remote.audit.result.error',
    'remote.audit.bytes',
    'remote.audit.loadFailed',
  ],
}

const Probe = () => {
  const { t, setLanguage } = useI18n()
  return (
    <>
      <button type="button" onClick={() => setLanguage('zh')}>
        Chinese
      </button>
      {Object.values(groups)
        .flat()
        .map((key) => (
          <span key={key} data-testid={key}>
            {t(key, { app: 'VS Code', workspace: 'Alpha', name: 'x' })}
          </span>
        ))}
    </>
  )
}

afterEach(() => cleanup())

test('translation groups resolve in English and Chinese', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  const english = new Map<TranslationKey, string>()
  for (const [group, keys] of Object.entries(groups)) {
    for (const key of keys) {
      const text = screen.getByTestId(key).textContent ?? ''
      expect(text.length, `missing English copy for ${group}: ${key}`).toBeGreaterThan(0)
      expect(text, `untranslated English key ${key}`).not.toBe(key)
      english.set(key, text)
    }
  }
  act(() => {
    screen.getByRole('button', { name: 'Chinese' }).click()
  })
  for (const [group, keys] of Object.entries(groups)) {
    for (const key of keys) {
      const text = screen.getByTestId(key).textContent ?? ''
      expect(text.length, `missing Chinese copy for ${group}: ${key}`).toBeGreaterThan(0)
      expect(text, `untranslated Chinese key ${key}`).not.toBe(key)
      if (group !== 'remote')
        expect(text, `Chinese copy for ${key} equals English`).not.toBe(english.get(key))
    }
  }
})
