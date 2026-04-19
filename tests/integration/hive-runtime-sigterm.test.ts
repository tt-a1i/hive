import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 50
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('hive runtime SIGTERM shutdown', () => {
  test('SIGTERM exits runtime and cleans up active PTY child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-sigterm-test-'))
    const workspacePath = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    const marker = `hive-sigterm-marker-${crypto.randomUUID()}`

    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        "import { runHiveCommand } from './src/cli/hive.ts'; await runHiveCommand(['--port','40128']);",
      ],
      {
        cwd: '/Users/admin/code/hive',
        env: { ...process.env, HIVE_DATA_DIR: join(root, 'data') },
        stdio: 'ignore',
      }
    )

    const baseUrl = 'http://127.0.0.1:40128'
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ui/session`)
      expect(response.status).toBe(200)
    })

    const cookieResponse = await fetch(`${baseUrl}/api/ui/session`)
    const cookie = cookieResponse.headers.get('set-cookie')
    if (!cookie) {
      throw new Error('Expected UI session cookie')
    }

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
    })
    const workspace = (await workspaceResponse.json()) as { id: string }
    const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })
    const worker = (await workerResponse.json()) as { id: string }

    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        command: '/bin/bash',
        args: ['-lc', `exec node -e "setInterval(() => {}, 1000)" -- ${marker}`],
      }),
    })

    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: '40128' }),
    })

    await waitFor(() => {
      const output = execSync(`ps aux | grep ${marker} | grep -v grep`, { encoding: 'utf8' })
      expect(output).toContain(marker)
    })

    child.kill('SIGTERM')

    await new Promise<void>((resolve, reject) => {
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Expected exit code 0, got ${code}`))
          return
        }

        resolve()
      })
    })

    const output = execSync(`ps aux | grep ${marker} | grep -v grep || true`, { encoding: 'utf8' })
    expect(output.trim()).toBe('')
  }, 15000)
})
