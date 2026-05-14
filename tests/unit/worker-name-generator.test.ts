import { describe, expect, test } from 'vitest'

import { generateWorkerName } from '../../web/src/worker/randomWorkerName.js'

describe('worker name generator', () => {
  test('returns a shell-friendly member name', () => {
    // First adjective + first noun + suffix 10+(0%90)=10
    expect(generateWorkerName(() => 0)).toBe('bouncy-alpaca-10')
  })

  test('uses separate random draws for each segment', () => {
    // ADJECTIVES[3]=chunky, NOUNS[4]=capybara, 10+(17%90)=27
    const draws = [3, 4, 17]
    expect(generateWorkerName(() => draws.shift() ?? 0)).toBe('chunky-capybara-27')
  })

  test('keeps generated names readable and safe for team send', () => {
    const name = generateWorkerName(() => 8)
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9]{2}$/)
    expect(name).not.toContain(' ')
  })
})
