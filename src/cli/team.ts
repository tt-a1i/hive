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

type ReportStatus = 'success' | 'failed'

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

const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }

  return response
}

const parseReportArgs = (args: string[]) => {
  const [result, ...rest] = args
  if (!result) {
    throw new Error('Usage: team report <result> [--success|--failed] [--artifact <path>]')
  }

  let status: ReportStatus = 'success'
  const artifacts: string[] = []

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]

    if (arg === '--success') {
      status = 'success'
      continue
    }

    if (arg === '--failed') {
      status = 'failed'
      continue
    }

    if (arg === '--artifact') {
      const artifactPath = rest[index + 1]
      if (!artifactPath) {
        throw new Error('Usage: team report <result> [--success|--failed] [--artifact <path>]')
      }

      artifacts.push(artifactPath)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { result, status, artifacts }
}

export const runTeamCommand = async (argv: string[]) => {
  const env = getHiveEnv()
  const [command, ...args] = argv
  const baseUrl = getBaseUrl(env)

  if (command === 'list') {
    const response = await fetch(`${baseUrl}/api/workspaces/${env.HIVE_PROJECT_ID}/team`, {
      method: 'GET',
      headers: {
        'x-hive-agent-id': env.HIVE_AGENT_ID,
        'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
      },
    })

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'send') {
    const [workerName, task] = args
    if (!workerName || !task || uuidPattern.test(workerName)) {
      throw new Error('Usage: team send <worker-name> <task>')
    }

    await postJson(`${baseUrl}/api/team/send`, {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      to: workerName,
      text: task,
    })
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)

    await postJson(`${baseUrl}/api/team/report`, {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: report.result,
      status: report.status,
      artifacts: report.artifacts,
    })
    return
  }

  throw new Error('Unsupported team command')
}
