import { describe, expect, test } from 'vitest'

import { generateWorkerName } from '../../web/src/worker/randomWorkerName.js'

describe('worker name generator', () => {
  test('returns a shell-friendly member name', () => {
    expect(generateWorkerName(() => 0)).toBe('atlas-beacon-10')
  })

  test('uses separate random draws for each segment', () => {
    const draws = [3, 4, 17]
    expect(generateWorkerName(() => draws.shift() ?? 0)).toBe('nova-relay-27')
  })

  test('keeps generated names readable and safe for team send', () => {
    const name = generateWorkerName(() => 8)
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9]{2}$/)
    expect(name).not.toContain(' ')
  })
})
