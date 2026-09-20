import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from './errors.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const integrationRoot =
  path.basename(path.dirname(moduleDirectory)) === 'dist'
    ? path.dirname(path.dirname(moduleDirectory))
    : path.dirname(moduleDirectory)

export interface BrowserTaskInput {
  url: string
  goal: string
  allow_execution: boolean
  allowed_origins?: string[] | undefined
  expect_url_contains?: string | undefined
  expect_title_contains?: string | undefined
  expect_text_contains?: string | undefined
  max_actions?: number | undefined
}

interface BrowserTaskOptions {
  timeoutMs?: number | undefined
}

export async function runBrowserTask(input: BrowserTaskInput, options: BrowserTaskOptions = {}) {
  if (input.allow_execution !== true) {
    throw new IntegrationError(
      'browser_execution_not_allowed',
      'allow_execution=true is required; no browser action was executed.'
    )
  }
  if (
    ![input.expect_url_contains, input.expect_title_contains, input.expect_text_contains].some(
      Boolean
    )
  ) {
    throw new IntegrationError(
      'browser_expectation_missing',
      'At least one independent expected outcome is required; no browser action was executed.'
    )
  }
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new IntegrationError(
      'browser_protocol_not_allowed',
      'Only HTTP(S) browser tasks are allowed.'
    )
  }
  const python =
    process.env.HIVE_JEV_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3')
  const runner = path.join(integrationRoot, 'scripts', 'browser-run.py')
  const allowedOrigins = input.allowed_origins?.length
    ? input.allowed_origins.map((origin) => new URL(origin).origin)
    : [url.origin]
  if (!allowedOrigins.includes(url.origin)) {
    throw new IntegrationError(
      'browser_start_origin_not_allowed',
      'The start URL origin must be allowlisted; no browser tab was opened.'
    )
  }
  const payload = {
    ...input,
    allowed_origins: allowedOrigins,
  }

  return new Promise((resolve, reject) => {
    const child = spawn(python, [runner], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HIVE_JEV_BROWSER_EXECUTION: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(
        new IntegrationError(
          'browser_timeout',
          'Browser task timed out; the runner was stopped without retrying an action.'
        )
      )
    }, options.timeoutMs ?? 120_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(
        new IntegrationError('browser_runner_start_failed', 'Browser runner could not start.', {
          cause: error,
        })
      )
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(
          new IntegrationError(
            'browser_runner_failed',
            stderr.trim().split(/\r?\n/u).at(-1) || `Browser runner exited with code ${code}.`
          )
        )
        return
      }
      try {
        const result: unknown = JSON.parse(stdout)
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
          throw new TypeError('Runner result must be an object.')
        }
        resolve(result)
      } catch (error) {
        reject(
          new IntegrationError(
            'browser_runner_invalid_json',
            'Browser runner returned invalid JSON.',
            { cause: error }
          )
        )
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
