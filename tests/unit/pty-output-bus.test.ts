import { describe, expect, test, vi } from 'vitest'

import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'

describe('pty output bus', () => {
  test('publish delivers chunks to subscribers', () => {
    const bus = createPtyOutputBus()
    const listener = vi.fn()

    bus.subscribe('run-1', listener)
    bus.publish('run-1', 'hello')

    expect(listener).toHaveBeenCalledWith('hello')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('unsubscribe stops future chunks for that listener', () => {
    const bus = createPtyOutputBus()
    const listener = vi.fn()

    const unsubscribe = bus.subscribe('run-1', listener)
    bus.publish('run-1', 'first')
    unsubscribe()
    bus.publish('run-1', 'second')

    expect(listener.mock.calls).toEqual([['first']])
  })

  test('multiple listeners on one run each receive the same chunk', () => {
    const bus = createPtyOutputBus()
    const left = vi.fn()
    const right = vi.fn()

    bus.subscribe('run-1', left)
    bus.subscribe('run-1', right)
    bus.publish('run-1', 'fanout')

    expect(left).toHaveBeenCalledWith('fanout')
    expect(right).toHaveBeenCalledWith('fanout')
  })

  test('clear removes old listeners but new listeners can subscribe again', () => {
    const bus = createPtyOutputBus()
    const oldListener = vi.fn()
    const newListener = vi.fn()

    bus.subscribe('run-1', oldListener)
    bus.clear('run-1')
    bus.publish('run-1', 'old')
    bus.subscribe('run-1', newListener)
    bus.publish('run-1', 'new')

    expect(oldListener).not.toHaveBeenCalled()
    expect(newListener.mock.calls).toEqual([['new']])
  })

  test('different run ids stay isolated', () => {
    const bus = createPtyOutputBus()
    const runOne = vi.fn()
    const runTwo = vi.fn()

    bus.subscribe('run-1', runOne)
    bus.subscribe('run-2', runTwo)
    bus.publish('run-1', 'alpha')

    expect(runOne).toHaveBeenCalledWith('alpha')
    expect(runTwo).not.toHaveBeenCalled()
  })
})
