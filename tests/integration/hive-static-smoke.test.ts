import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
  delete process.env.HIVE_DATA_DIR
  delete process.env.HIVE_STATIC_DIR
})

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

describe('hive static smoke', () => {
  test('CLI entry boots runtime and production server serves static index plus API', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-static-smoke-'))
    const staticDir = join(process.cwd(), 'web', 'dist')
    tempDirs.push(dataDir)
    expect(existsSync(join(staticDir, 'index.html'))).toBe(true)

    process.env.HIVE_DATA_DIR = dataDir
    process.env.HIVE_STATIC_DIR = staticDir

    const modulePath = new URL('../../src/cli/hive.ts', import.meta.url)
    const { execFile, spawn } = await import('node:child_process')
    const processHandle = spawn(
      process.execPath,
      ['--import', 'tsx', modulePath.pathname, '--port', '0'],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    processHandle.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    try {
      await waitFor(() => {
        expect(stdout).toContain('Hive running at http://127.0.0.1:')
      })
      const match = stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)
      expect(match?.[1]).toBeTruthy()
      const port = Number(match?.[1])
      const cookieJar = join(dataDir, 'cookie.jar')

      const curl = (args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('curl', args, (error, curlStdout, curlStderr) => {
            if (error) {
              reject(error)
              return
            }
            resolve({ stderr: curlStderr, stdout: curlStdout })
          })
        })

      const sessionResponse = await curl([
        '-i',
        '-c',
        cookieJar,
        `http://127.0.0.1:${port}/api/ui/session`,
      ])
      expect(sessionResponse.stdout).toContain('HTTP/1.1 200 OK')

      const apiResponse = await curl([
        '-i',
        '-b',
        cookieJar,
        `http://127.0.0.1:${port}/api/workspaces`,
      ])
      expect(apiResponse.stdout).toContain('HTTP/1.1 200 OK')
      expect(apiResponse.stdout).toContain('[]')

      const rootResponse = await curl(['-i', `http://127.0.0.1:${port}/`])
      expect(rootResponse.stdout).toContain('HTTP/1.1 200 OK')
      expect(rootResponse.stdout).toContain('<div id="root"></div>')
      const assetMatch = rootResponse.stdout.match(/\/assets\/[^"']+\.js/)
      expect(assetMatch?.[0]).toBeTruthy()

      const assetResponse = await curl(['-i', `http://127.0.0.1:${port}${assetMatch?.[0]}`])
      expect(assetResponse.stdout).toContain('HTTP/1.1 200 OK')
      expect(assetResponse.stdout.toLowerCase()).toContain('content-type: text/javascript')
    } finally {
      processHandle.kill('SIGTERM')
      await new Promise<void>((resolve) => processHandle.once('exit', () => resolve()))
    }
  })
})
