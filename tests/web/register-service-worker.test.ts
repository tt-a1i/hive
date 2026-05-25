// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetServiceWorkerUpdateStateForTests,
  registerServiceWorkerWithEnv,
  type ServiceWorkerUpdateApply,
  subscribeServiceWorkerUpdate,
} from '../../web/src/pwa/register-service-worker.js'

// jsdom does not implement ServiceWorker, so we feed registerServiceWorkerWithEnv
// hand-rolled EventTarget-based stand-ins. Anything that the registration code
// observes (state transitions, controllerchange events, error rejections) is
// dispatched through these mocks, so the assertions hold against the real
// behavior path — not against a recording of what we fed in.

class MockServiceWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
  postMessage = vi.fn<(message: unknown) => void>()

  transitionTo(state: ServiceWorkerState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class MockRegistration extends EventTarget {
  installing: MockServiceWorker | null = null
  waiting: MockServiceWorker | null = null
  active: MockServiceWorker | null = null
  unregister = vi.fn().mockResolvedValue(true)
}

class MockContainer extends EventTarget {
  controller: MockServiceWorker | null = null
  register = vi.fn<(url: string) => Promise<MockRegistration>>()
  getRegistrations = vi.fn<() => Promise<MockRegistration[]>>().mockResolvedValue([])
}

beforeEach(() => {
  __resetServiceWorkerUpdateStateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('registerServiceWorkerWithEnv', () => {
  test('dev mode unregisters every prior registration and never calls register()', async () => {
    const reg1 = new MockRegistration()
    const reg2 = new MockRegistration()
    const container = new MockContainer()
    container.getRegistrations.mockResolvedValue([reg1, reg2])

    await registerServiceWorkerWithEnv({
      isProd: false,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })

    expect(container.getRegistrations).toHaveBeenCalled()
    expect(reg1.unregister).toHaveBeenCalledTimes(1)
    expect(reg2.unregister).toHaveBeenCalledTimes(1)
    expect(container.register).not.toHaveBeenCalled()
  })

  test('returns immediately when the navigator has no serviceWorker support', async () => {
    const reload = vi.fn()
    await registerServiceWorkerWithEnv({ isProd: true, reload, serviceWorker: null })
    expect(reload).not.toHaveBeenCalled()
  })

  test('fresh install with no prior controller does not announce an update', async () => {
    const registration = new MockRegistration()
    const installing = new MockServiceWorker()
    registration.installing = installing
    const container = new MockContainer()
    container.controller = null
    container.register.mockResolvedValue(registration)

    const notifications: Array<ServiceWorkerUpdateApply | null> = []
    const unsubscribe = subscribeServiceWorkerUpdate((apply) => notifications.push(apply))

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    installing.transitionTo('installed')

    // First notification is the subscribe baseline (null). Nothing else should
    // arrive because the page had no prior controller — this is the first
    // install path which is silent.
    expect(notifications).toEqual([null])
    unsubscribe()
  })

  test('update notification fires when an installed worker arrives behind an existing controller', async () => {
    const registration = new MockRegistration()
    const installing = new MockServiceWorker()
    registration.installing = installing
    const container = new MockContainer()
    container.controller = new MockServiceWorker()
    container.register.mockResolvedValue(registration)

    let received: ServiceWorkerUpdateApply | null = null
    const unsubscribe = subscribeServiceWorkerUpdate((apply) => {
      if (apply) received = apply
    })

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    installing.transitionTo('installed')

    expect(received).not.toBeNull()
    expect(typeof received).toBe('function')
    unsubscribe()
  })

  test('an SW already in `waiting` at boot announces an update immediately', async () => {
    // Browsers persist registrations across reloads. If a previous tab left an
    // updated SW in `waiting`, the freshly-loaded tab still gets the prior
    // controller — we must surface the update without an `updatefound` event.
    const registration = new MockRegistration()
    const waiting = new MockServiceWorker()
    waiting.state = 'installing'
    registration.waiting = waiting
    const container = new MockContainer()
    container.controller = new MockServiceWorker()
    container.register.mockResolvedValue(registration)

    let received: ServiceWorkerUpdateApply | null = null
    const unsubscribe = subscribeServiceWorkerUpdate((apply) => {
      if (apply) received = apply
    })

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    // Now the waiting worker reaches the `installed` state (this is what
    // happens when the browser commits the install on the next tab load).
    waiting.transitionTo('installed')

    expect(received).not.toBeNull()
    unsubscribe()
  })

  test('a late `updatefound` after register() resolved still produces an update notification', async () => {
    // Cover the path where the registration is settled with no pending worker
    // and the browser fires `updatefound` minutes later. This is the common
    // background-update case for a long-lived tab.
    const registration = new MockRegistration()
    const container = new MockContainer()
    container.controller = new MockServiceWorker()
    container.register.mockResolvedValue(registration)

    let received: ServiceWorkerUpdateApply | null = null
    const unsubscribe = subscribeServiceWorkerUpdate((apply) => {
      if (apply) received = apply
    })

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    expect(received).toBeNull() // nothing installing yet

    // Background: a new worker shows up and the browser fires updatefound.
    const newWorker = new MockServiceWorker()
    registration.installing = newWorker
    registration.dispatchEvent(new Event('updatefound'))
    newWorker.transitionTo('installed')

    expect(received).not.toBeNull()
    unsubscribe()
  })

  test('applying the update posts SKIP_WAITING and reloads via fallback timer', async () => {
    vi.useFakeTimers()
    const registration = new MockRegistration()
    const installing = new MockServiceWorker()
    registration.installing = installing
    const container = new MockContainer()
    container.controller = new MockServiceWorker()
    container.register.mockResolvedValue(registration)

    let apply: ServiceWorkerUpdateApply | null = null
    const unsubscribe = subscribeServiceWorkerUpdate((received) => {
      if (received) apply = received
    })

    const reload = vi.fn()
    await registerServiceWorkerWithEnv({
      isProd: true,
      reload,
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    installing.transitionTo('installed')

    expect(apply).not.toBeNull()
    ;(apply as unknown as () => void)?.()
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reload).not.toHaveBeenCalled()

    // The fallback reload should fire ~2s later in case controllerchange never
    // arrives.
    vi.advanceTimersByTime(1999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(reload).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  test('controllerchange reloads exactly once even if the event fires repeatedly', async () => {
    const container = new MockContainer()
    container.register.mockResolvedValue(new MockRegistration())
    const reload = vi.fn()

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload,
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })

    container.dispatchEvent(new Event('controllerchange'))
    container.dispatchEvent(new Event('controllerchange'))
    container.dispatchEvent(new Event('controllerchange'))

    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('register() failures are swallowed so they do not block app boot', async () => {
    const container = new MockContainer()
    container.register.mockRejectedValue(new Error('boom'))

    await expect(
      registerServiceWorkerWithEnv({
        isProd: true,
        reload: vi.fn(),
        serviceWorker: container as unknown as ServiceWorkerContainer,
      })
    ).resolves.toBeUndefined()
  })
})

describe('subscribeServiceWorkerUpdate', () => {
  test('new subscribers see the current update state synchronously', () => {
    const seen: Array<ServiceWorkerUpdateApply | null> = []
    const unsubscribe = subscribeServiceWorkerUpdate((value) => seen.push(value))
    expect(seen).toEqual([null])
    unsubscribe()
  })

  test('unsubscribing stops further notifications', async () => {
    const registration = new MockRegistration()
    const installing = new MockServiceWorker()
    registration.installing = installing
    const container = new MockContainer()
    container.controller = new MockServiceWorker()
    container.register.mockResolvedValue(registration)

    const seen: Array<ServiceWorkerUpdateApply | null> = []
    const unsubscribe = subscribeServiceWorkerUpdate((value) => seen.push(value))
    expect(seen).toEqual([null])

    unsubscribe()

    await registerServiceWorkerWithEnv({
      isProd: true,
      reload: vi.fn(),
      serviceWorker: container as unknown as ServiceWorkerContainer,
    })
    installing.transitionTo('installed')

    expect(seen).toEqual([null]) // no further notifications
  })
})
