import { afterEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hive cli', () => {
  test('starts http server and prints listening address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'])

    try {
      expect(result.port).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(`Hive running at http://127.0.0.1:${result.port}`)
    } finally {
      await result.close()
    }
  })
})
