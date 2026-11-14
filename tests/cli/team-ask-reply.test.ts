import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'

test('real ask/reply CLI blocks, resumes after timeout and interruption, and enforces protocol permissions', async () => {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/check-team-question-recovery.ts'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 90000,
        }
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data
      })
      child.stderr.on('data', (data) => {
        stderr += data
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    }
  )
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('PASS: short CLI reply routing;')
}, 95000)
