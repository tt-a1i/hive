// @vitest-environment jsdom
//
// M5b impl:substitutes — the mobile entry that hosts ConnectView over the M5a flow and reveals the app
// once a tunnel is live. It mounts ConnectView while NOT connected and swaps to the app children on the
// 'connected' phase. The crypto (resolveSession/connectTransport) is injected — the entry only
// orchestrates flow ↔ view ↔ app reveal.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type {
  ConnectFlow,
  ConnectFlowDeps,
  ConnectResult,
  MachineView,
} from '../../web/src/connect/connect-flow.js'
import { buildPairingPayloadFromCode } from '../../web/src/connect/pair-code.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { MobileEntry } from '../../web/src/mobile/entry-mobile.js'

const machines: MachineView[] = [
  { id: 'daemon-a', name: 'Studio', lastSeen: 1, revoked: false, online: true },
]

interface SelectCall {
  daemonId: string
  qr?: string
}

// A fake flow whose selectDaemon transitions to 'connected' and fires onPhase, mirroring the real one.
// `onSelect` captures the (daemonId, payload) the entry drove selectDaemon with.
const makeFakeFlow = (
  onSelect?: (call: SelectCall) => void
): ((deps: ConnectFlowDeps) => ConnectFlow) => {
  return (deps) => {
    let phase: ConnectFlow['phase'] = 'login'
    return {
      get phase() {
        return phase
      },
      pairingClient: null,
      loadMachines: async () => {
        phase = 'machines'
        deps.onPhase?.('machines')
        return { daemons: machines, selfDeviceId: null }
      },
      selectDaemon: async (daemonId: string, qrPayload?: string) => {
        onSelect?.({ daemonId, ...(qrPayload === undefined ? {} : { qr: qrPayload }) })
        phase = 'connected'
        deps.onPhase?.('connected')
        return { ok: true as const }
      },
    }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.location.hash = ''
  window.sessionStorage.clear()
})

describe('MobileEntry', () => {
  test('shows the connection gate before connect, then reveals the app children after connected', async () => {
    render(
      <I18nProvider>
        <MobileEntry createFlow={makeFakeFlow()} connectTransport={async () => ({ ok: true })}>
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    expect(screen.queryByTestId('mounted-app')).toBeNull()
    const row = await screen.findByTestId('connect-machine-daemon-a')

    // Selecting a (paired) daemon connects; the app reveals and ConnectView unmounts.
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('mounted-app')).toBeTruthy())
    expect(screen.queryByTestId('connect-machines')).toBeNull()
  })

  test('manual pairing code is converted into a pairing payload for the selected machine', async () => {
    const selectCalls: SelectCall[] = []
    const selectingFlow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: null,
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async (daemonId: string, qr?: string) => {
          selectCalls.push({ daemonId, ...(qr === undefined ? {} : { qr }) })
          if (qr === undefined) {
            phase = 'selecting'
            deps.onPhase?.('selecting')
            return {
              ok: false as const,
              failure: { code: 'needs_pairing' as const, message: 'need code' },
            }
          }
          phase = 'connected'
          deps.onPhase?.('connected')
          return { ok: true as const }
        },
      }
    }

    render(
      <I18nProvider>
        <MobileEntry
          createFlow={selectingFlow}
          connectTransport={async () => ({ ok: true })}
          gatewayBaseUrl="https://app.hivehq.dev"
        >
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))
    const input = await screen.findByTestId('connect-code-input')
    fireEvent.change(input, { target: { value: 'ABCD-EFGH-JK23' } })
    fireEvent.click(screen.getByTestId('connect-code-submit'))

    const expected = await buildPairingPayloadFromCode({
      code: 'ABCD-EFGH-JK23',
      daemonId: 'daemon-a',
      gatewayUrl: 'https://app.hivehq.dev',
    })
    await waitFor(() =>
      expect(selectCalls.some((c) => c.daemonId === 'daemon-a' && c.qr === expected)).toBe(true)
    )
  })

  test('pairing failures from the flow render as localized status copy', async () => {
    const failingFlow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: {
          // start is never invoked here (selectDaemon is faked); a typed no-op keeps the mock
          // structurally a PairingClient.
          start: vi.fn(async () => ({ ok: true as const, deviceId: 'unused' })),
          cancel: vi.fn(),
          dispose: vi.fn(),
          phase: 'error',
          sas: null,
          deviceId: null,
        },
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async () => {
          phase = 'pairing'
          deps.onPhase?.('pairing')
          deps.onPairingPhase?.('error')
          deps.onPairingFailure?.({ code: 'mint_forbidden', message: 'not confirmed' })
          return { ok: false, failure: { code: 'mint_forbidden', message: 'not confirmed' } }
        },
      }
    }

    render(
      <I18nProvider>
        <MobileEntry createFlow={failingFlow} connectTransport={async () => ({ ok: true })}>
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))

    const status = await screen.findByTestId('connect-pairing-phase')
    expect(status.textContent).toBe('Pairing was not confirmed on your computer.')
    expect(status.textContent).not.toContain('mint_forbidden')
    expect(status.textContent).not.toContain('error')

    fireEvent.click(screen.getByTestId('connect-pairing-cancel'))
    expect(await screen.findByTestId('connect-pair-guide')).toBeTruthy()
    expect(screen.queryByTestId('connect-pairing-phase')).toBeNull()
  })

  test('retrying after a post-pair tunnel failure clears the previous SAS while the next pairing connects', async () => {
    let qrAttempts = 0
    const retryFlow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: null,
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async (_daemonId: string, qr?: string) => {
          if (qr === undefined) {
            phase = 'selecting'
            deps.onPhase?.('selecting')
            return {
              ok: false as const,
              failure: { code: 'needs_pairing' as const, message: 'pair' },
            }
          }

          qrAttempts += 1
          if (qrAttempts === 1) {
            phase = 'pairing'
            deps.onPhase?.('pairing')
            deps.onPairingPhase?.('awaiting_confirm')
            deps.onPairingSas?.('111111')
            deps.onPairingPhase?.('paired')
            phase = 'selecting'
            deps.onPhase?.('selecting')
            return {
              ok: false as const,
              failure: { code: 'select_failed' as const, message: 'tunnel failed' },
            }
          }

          phase = 'pairing'
          deps.onPhase?.('pairing')
          deps.onPairingPhase?.('connecting')
          return new Promise(() => {})
        },
      }
    }

    render(
      <I18nProvider>
        <MobileEntry
          createFlow={retryFlow}
          connectTransport={async () => ({ ok: true })}
          gatewayBaseUrl="https://app.hivehq.dev"
        >
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))
    const input = await screen.findByTestId('connect-code-input')
    fireEvent.change(input, { target: { value: 'ABCD-EFGH-JK23' } })

    const err = await screen.findByTestId('connect-error')
    expect(err.textContent).toContain("Couldn't reach that computer")

    fireEvent.change(await screen.findByTestId('connect-code-input'), {
      target: { value: '2345-6789-ABCD' },
    })

    await screen.findByTestId('connect-pairing-phase')
    expect(qrAttempts).toBe(2)
    expect(screen.queryByTestId('connect-pairing-sas')).toBeNull()
  })

  test('canceling a pending pairing ignores its stale failure result', async () => {
    const pairingCompletion: { resolve?: (result: ConnectResult) => void } = {}
    const pendingFlow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: null,
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async (_daemonId: string, qr?: string) => {
          if (qr === undefined) {
            phase = 'selecting'
            deps.onPhase?.('selecting')
            return {
              ok: false as const,
              failure: { code: 'needs_pairing' as const, message: 'pair' },
            }
          }

          phase = 'pairing'
          deps.onPhase?.('pairing')
          deps.onPairingPhase?.('connecting')
          return new Promise<ConnectResult>((resolve) => {
            pairingCompletion.resolve = resolve
          })
        },
      }
    }

    render(
      <I18nProvider>
        <MobileEntry
          createFlow={pendingFlow}
          connectTransport={async () => ({ ok: true })}
          gatewayBaseUrl="https://app.hivehq.dev"
        >
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))
    fireEvent.change(await screen.findByTestId('connect-code-input'), {
      target: { value: 'ABCD-EFGH-JK23' },
    })
    await screen.findByTestId('connect-pairing-phase')

    fireEvent.click(screen.getByTestId('connect-pairing-cancel'))
    expect(await screen.findByTestId('connect-pair-guide')).toBeTruthy()

    if (!pairingCompletion.resolve) throw new Error('Expected pending pairing')
    pairingCompletion.resolve({
      ok: false,
      failure: { code: 'select_failed', message: 'late tunnel failure' },
    })

    await waitFor(() => expect(screen.queryByTestId('connect-error')).toBeNull())
    expect(screen.getByTestId('connect-pair-guide')).toBeTruthy()
  })

  test('a select_failed reconnect surfaces a visible connect error (not swallowed)', async () => {
    // A stored-session reconnect that fails returns select_failed. The OLD entry did `void selectDaemon()`
    // and dropped the result, leaving the user on the machines/selecting screen with no explanation.
    const flow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: null,
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async () => ({
          ok: false as const,
          failure: { code: 'select_failed' as const, message: 'stale session' },
        }),
      }
    }

    render(
      <I18nProvider>
        <MobileEntry createFlow={flow} connectTransport={async () => ({ ok: true })}>
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))

    const err = await screen.findByTestId('connect-error')
    expect(err.textContent).toContain("Couldn't reach that computer")
  })

  test('an incomplete pairing code keeps submit disabled and does not start pairing', async () => {
    const selectCalls: SelectCall[] = []
    const flow = (deps: ConnectFlowDeps): ConnectFlow => {
      let phase: ConnectFlow['phase'] = 'login'
      return {
        get phase() {
          return phase
        },
        pairingClient: null,
        loadMachines: async () => {
          phase = 'machines'
          deps.onPhase?.('machines')
          return { daemons: machines, selfDeviceId: null }
        },
        selectDaemon: async (_daemonId: string, qr?: string) => {
          selectCalls.push({ daemonId: _daemonId, ...(qr === undefined ? {} : { qr }) })
          if (qr === undefined) {
            phase = 'selecting'
            deps.onPhase?.('selecting')
            return {
              ok: false as const,
              failure: { code: 'needs_pairing' as const, message: 'pair' },
            }
          }
          return { ok: true as const }
        },
      }
    }

    render(
      <I18nProvider>
        <MobileEntry
          createFlow={flow}
          connectTransport={async () => ({ ok: true })}
          gatewayBaseUrl="https://app.hivehq.dev"
        >
          <div data-testid="mounted-app">app</div>
        </MobileEntry>
      </I18nProvider>
    )

    fireEvent.click(await screen.findByTestId('connect-machine-daemon-a'))
    const input = await screen.findByTestId('connect-code-input')
    fireEvent.change(input, { target: { value: '12' } })
    const submit = screen.getByTestId('connect-code-submit')

    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(selectCalls).toEqual([{ daemonId: 'daemon-a' }])
    expect(screen.queryByTestId('connect-error')).toBeNull()
  })
})
