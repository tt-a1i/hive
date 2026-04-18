import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'

test('root project config exists', () => {
  expect(existsSync('package.json')).toBe(true)
  expect(existsSync('tsconfig.json')).toBe(true)
  expect(existsSync('vitest.config.ts')).toBe(true)
})
