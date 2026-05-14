import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_ENV_KEYS = [
  'HIVE_PORT',
  'HIVE_PROJECT_ID',
  'HIVE_AGENT_ID',
  'HIVE_AGENT_TOKEN',
] as const

type HiveEnvKey = (typeof REQUIRED_ENV_KEYS)[number]

interface HiveEnv {
  HIVE_PORT: string
  HIVE_PROJECT_ID: string
  HIVE_AGENT_ID: string
  HIVE_AGENT_TOKEN: string
}

const TEAM_USAGE = [
  'Usage:',
  '  team list',
  '  team send <worker-name> "<task>"',
  '  team report "<result>" [--dispatch <dispatch-id>] [--artifact <path>]',
  '  team status "<current status>" [--artifact <path>]',
].join('\n')

const getHiveEnv = (): HiveEnv => {
  const values = Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Partial<Record<HiveEnvKey, string>>

  if (REQUIRED_ENV_KEYS.some((key) => !values[key])) {
    throw new Error('Missing required Hive environment variables')
  }

  return values as HiveEnv
}

const getBaseUrl = (env: HiveEnv) => `http://127.0.0.1:${env.HIVE_PORT}`

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const describeFetchError = (baseUrl: string, error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `Failed to reach Hive runtime at ${baseUrl}: ${message}${cause}. Check HIVE_PORT and make sure the Hive runtime is still running.`
}

const fetchRuntime = async (baseUrl: string, path: string, init: RequestInit) => {
  try {
    return await fetch(`${baseUrl}${path}`, init)
  } catch (error) {
    throw new Error(describeFetchError(baseUrl, error))
  }
}

const readHttpErrorDetail = async (response: Response) => {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return ''

  try {
    const body = JSON.parse(trimmed) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
  } catch {
    // Non-JSON responses still carry useful diagnostics in their text body.
  }

  return trimmed
}

const throwHttpError = async (response: Response): Promise<never> => {
  const detail = await readHttpErrorDetail(response)
  throw new Error(
    detail
      ? `Request failed with status ${response.status}: ${detail}`
      : `Request failed with status ${response.status}`
  )
}

const postJson = async (baseUrl: string, path: string, body: unknown) => {
  const response = await fetchRuntime(baseUrl, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    await throwHttpError(response)
  }

  return response
}

interface TeamReportResponse {
  dispatch_id: string | null
  forward_error?: string | null
  forwarded?: boolean
  ok: true
}

const parseReportArgs = (args: string[], command = 'report') => {
  const [result, ...rest] = args
  if (!result) {
    throw new Error(
      command === 'status'
        ? 'Usage: team status <current status> [--artifact <path>]'
        : 'Usage: team report <result> [--dispatch <dispatch-id>] [--artifact <path>]'
    )
  }

  const artifacts: string[] = []
  let dispatchId: string | undefined

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]

    if (arg === '--success' || arg === '--failed') {
      // Backward-compatible no-op: reports are interpreted from their text.
      continue
    }

    if (arg === '--artifact') {
      const artifactPath = rest[index + 1]
      if (!artifactPath) {
        throw new Error(
          command === 'status'
            ? 'Usage: team status <current status> [--artifact <path>]'
            : 'Usage: team report <result> [--dispatch <dispatch-id>] [--artifact <path>]'
        )
      }

      artifacts.push(artifactPath)
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      if (command === 'status') {
        throw new Error('team status does not accept --dispatch; use team report for assigned work')
      }
      const nextDispatchId = rest[index + 1]
      if (!nextDispatchId) {
        throw new Error(
          'Usage: team report <result> [--dispatch <dispatch-id>] [--artifact <path>]'
        )
      }

      dispatchId = nextDispatchId
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { result, artifacts, dispatchId }
}

export const runTeamCommand = async (argv: string[]) => {
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TEAM_USAGE)
    return
  }

  if (command === 'list') {
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(baseUrl, `/api/workspaces/${env.HIVE_PROJECT_ID}/team`, {
      method: 'GET',
      headers: {
        'x-hive-agent-id': env.HIVE_AGENT_ID,
        'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
      },
    })

    if (!response.ok) {
      await throwHttpError(response)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'send') {
    const [workerName, ...taskParts] = args
    const task = taskParts.join(' ').trim()
    if (!workerName || !task || uuidPattern.test(workerName)) {
      throw new Error('Usage: team send <worker-name> <task>')
    }

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/send', {
      hive_port: env.HIVE_PORT,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      to: workerName,
      text: task,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'status') {
    const report = parseReportArgs(args, 'status')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/status', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: report.result,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `Hive recorded the status update, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/report', {
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: report.result,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `Hive recorded the report, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  throw new Error('Unsupported team command')
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  void runTeamCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
