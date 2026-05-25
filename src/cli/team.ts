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
  '  team send <worker-name> "<task>" [--task <id>] [--create-task]',
  '  team cancel --dispatch <dispatch-id> "<reason>"',
  '  team report "<result>" [--dispatch <dispatch-id>] [--priority failed|blocked|normal] [--artifact <path>]',
  '  team report --stdin [--dispatch <dispatch-id>] [--priority failed|blocked|normal] [--artifact <path>]',
  '  team status "<current status>" [--artifact <path>]',
  '  team status --stdin [--artifact <path>]',
  '  team task list [--status <status>]',
  '  team task create "<title>"',
  '  team task done <id>',
  '  team task block <id>',
  '  team task cancel <id>',
  '  team task show <id>',
  '  team discuss --start --members "<w1>,<w2>" --topic "<question>" [--rounds 3] [--join] [--listen stdin]',
  '  team discuss "<message>"',
  '  team discuss --final "<final-position>"',
  '  team discuss --end [--cancel] [--reason "<reason>"]',
  '  team discuss --skip <worker-name>',
  '  team discuss --steer "<direction>"',
  '  team discuss --extend [N]',
  '',
  'Flags can appear in any order. Use --stdin to pipe long bodies and avoid shell-escaping issues.',
  "Use a quoted heredoc (<<'EOF') so $vars, backticks, and command substitutions stay literal:",
  "  team report --stdin --dispatch <id> <<'EOF'",
  '  ... long report ...',
  '  EOF',
  '',
  'For role rules, workflow, and recovery instructions, see .hive/PROTOCOL.md',
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

interface ParsedCancelArgs {
  dispatchId: string
  reason: string
}

const REPORT_USAGE =
  'Usage: team report (<result> | --stdin) [--dispatch <dispatch-id>] [--priority failed|blocked|normal] [--artifact <path>]'
const STATUS_USAGE = 'Usage: team status (<current status> | --stdin) [--artifact <path>]'
const CANCEL_USAGE = 'Usage: team cancel --dispatch <dispatch-id> <reason>'

const usageFor = (command: string) => (command === 'status' ? STATUS_USAGE : REPORT_USAGE)

const withUsage = (message: string, command: string) => `${message}\n\n${usageFor(command)}`

export type ReportPriority = 'failed' | 'blocked' | 'normal'

export interface ParsedReportArgs {
  artifacts: string[]
  checkpoint: string | undefined
  dispatchId: string | undefined
  priority: ReportPriority | undefined
  result: string | null
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let checkpoint: string | undefined
  let dispatchId: string | undefined
  let priority: ReportPriority | undefined
  let useStdin = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    // Backward-compatible no-op: reports are interpreted from their text.
    if (arg === '--success' || arg === '--failed') continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--artifact requires a value', command))
      }
      artifacts.push(next)
      index += 1
      continue
    }

    if (arg === '--priority') {
      if (command === 'status') {
        throw new Error(withUsage('team status does not accept --priority', command))
      }
      const next = args[index + 1]
      if (next !== 'failed' && next !== 'blocked' && next !== 'normal') {
        throw new Error(withUsage('--priority must be one of: failed, blocked, normal', command))
      }
      priority = next
      index += 1
      continue
    }

    if (arg === '--checkpoint') {
      if (command === 'status') {
        throw new Error(withUsage('team status does not accept --checkpoint', command))
      }
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--checkpoint requires a value', command))
      }
      checkpoint = next
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      if (command === 'status') {
        throw new Error(
          withUsage(
            'team status does not accept --dispatch; use team report for assigned work',
            command
          )
        )
      }
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--dispatch requires a value', command))
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(withUsage(`Unknown argument: ${arg}`, command))
    }

    positionals.push(arg)
  }

  if (useStdin && positionals.length > 0) {
    throw new Error(
      withUsage(
        '--stdin is mutually exclusive with a positional argument; pass the body on stdin or as an argument, not both',
        command
      )
    )
  }

  if (!useStdin && positionals.length === 0) {
    const label = command === 'status' ? '<current status>' : '<result>'
    throw new Error(withUsage(`Missing ${label} (or pass --stdin to read it from stdin)`, command))
  }
  if (positionals.length > 1) {
    const label = command === 'status' ? 'status' : 'result'
    throw new Error(
      withUsage(
        `Expected exactly one ${label} positional, got ${positionals.length}: ${positionals
          .map((value) => JSON.stringify(value))
          .join(', ')}`,
        command
      )
    )
  }

  return { result: useStdin ? null : (positionals[0] ?? null), artifacts, checkpoint, dispatchId, priority, useStdin }
}

const SEQ_PATTERN = /^#(\d+)$/

const resolveTaskId = async (
  baseUrl: string,
  env: HiveEnv,
  idOrSeq: string,
  headers: Record<string, string>
): Promise<string> => {
  const seqMatch = idOrSeq.match(SEQ_PATTERN)
  if (!seqMatch) return idOrSeq
  const seq = seqMatch[1]
  const qs = new URLSearchParams({ workspace_id: env.HIVE_PROJECT_ID, seq: seq! })
  const response = await fetchRuntime(baseUrl, `/api/team/tasks?${qs.toString()}`, {
    method: 'GET',
    headers,
  })
  if (!response.ok) {
    throw new Error(`Task #${seq} not found`)
  }
  const body = (await response.json()) as { task?: { id: string } }
  if (!body.task?.id) {
    throw new Error(`Task #${seq} not found`)
  }
  return body.task.id
}

export const parseCancelArgs = (args: string[]): ParsedCancelArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--dispatch requires a value\n\n${CANCEL_USAGE}`)
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${CANCEL_USAGE}`)
    }

    positionals.push(arg)
  }

  if (!dispatchId) {
    throw new Error(`Missing --dispatch <dispatch-id>\n\n${CANCEL_USAGE}`)
  }
  if (positionals.length === 0) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  const reason = positionals.join(' ').trim()
  if (!reason) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  return { dispatchId, reason }
}

export const readStdinToString = async (command = 'report'): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      withUsage(
        '--stdin requires piped input, but stdin is a TTY. Did you forget to pipe content in?',
        command
      )
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const content = Buffer.concat(chunks).toString('utf8')
  if (!content.trim()) {
    throw new Error(withUsage('--stdin received empty input', command))
  }
  return content
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
    let taskId: string | undefined
    let createTask = false
    const filtered: string[] = []

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--task' && args[i + 1]) { taskId = args[++i]; continue }
      if (arg === '--create-task') { createTask = true; continue }
      filtered.push(arg!)
    }

    const [workerName, ...taskParts] = filtered
    const task = taskParts.join(' ').trim()
    if (!workerName || !task || uuidPattern.test(workerName)) {
      throw new Error('Usage: team send <worker-name> <task> [--task <id>] [--create-task]')
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
      ...(taskId ? { task_id: taskId } : {}),
      ...(createTask ? { create_task: true } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'cancel') {
    const cancel = parseCancelArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    await postJson(baseUrl, '/api/team/cancel', {
      dispatch_id: cancel.dispatchId,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      reason: cancel.reason,
    })
    return
  }

  if (command === 'status') {
    const report = parseReportArgs(args, 'status')
    const body = report.useStdin ? await readStdinToString('status') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/status', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: body,
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
    const body = report.useStdin ? await readStdinToString('report') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/report', {
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      ...(report.priority ? { priority: report.priority } : {}),
      ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: body,
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

  if (command === 'task') {
    const [subcommand, ...subArgs] = args

    if (!subcommand || subcommand === '--help') {
      console.log([
        'Usage:',
        '  team task list [--status <status>]',
        '  team task create "<title>"',
        '  team task done <id>',
        '  team task block <id>',
        '  team task cancel <id>',
        '  team task show <id>',
      ].join('\n'))
      return
    }

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const authHeaders = {
      'x-hive-agent-id': env.HIVE_AGENT_ID,
      'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
    }

    if (subcommand === 'list') {
      let status: string | undefined
      for (let i = 0; i < subArgs.length; i++) {
        if (subArgs[i] === '--status' && subArgs[i + 1]) { status = subArgs[++i]; continue }
      }
      const qs = new URLSearchParams({ workspace_id: env.HIVE_PROJECT_ID })
      if (status) qs.set('status', status)
      const response = await fetchRuntime(baseUrl, `/api/team/tasks?${qs.toString()}`, {
        method: 'GET',
        headers: authHeaders,
      })
      if (!response.ok) await throwHttpError(response)
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'show') {
      const rawId = subArgs[0]
      if (!rawId) throw new Error('Usage: team task show <id|#seq>')
      const id = await resolveTaskId(baseUrl, env, rawId, authHeaders)
      const response = await fetchRuntime(baseUrl, `/api/team/tasks/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: authHeaders,
      })
      if (!response.ok) await throwHttpError(response)
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'create') {
      const title = subArgs.join(' ').trim()
      if (!title) throw new Error('Usage: team task create "<title>"')
      const response = await postJson(baseUrl, '/api/team/tasks', {
        workspace_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        title,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'done' || subcommand === 'block' || subcommand === 'cancel') {
      const rawId = subArgs[0]
      if (!rawId) throw new Error(`Usage: team task ${subcommand} <id|#seq>`)
      const id = await resolveTaskId(baseUrl, env, rawId, authHeaders)
      const statusMap = { done: 'done', block: 'blocked', cancel: 'cancelled' } as const
      const response = await postJson(baseUrl, `/api/team/tasks/${encodeURIComponent(id)}/status`, {
        workspace_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        status: statusMap[subcommand],
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    throw new Error(`Unknown task subcommand: ${subcommand}`)
  }

  if (command === 'discuss') {
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)

    // --start: create discussion group
    if (args.includes('--start')) {
      let members: string | undefined
      let topic: string | undefined
      let rounds: number | undefined
      let listenMode: string | undefined
      const orchJoin = args.includes('--join')

      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--members' && args[i + 1]) { members = args[++i]; continue }
        if (arg === '--topic' && args[i + 1]) { topic = args[++i]; continue }
        if (arg === '--rounds' && args[i + 1]) { rounds = Number(args[++i]); continue }
        if (arg === '--listen' && args[i + 1]) { listenMode = args[++i]; continue }
      }

      if (!members || !topic) {
        throw new Error('Usage: team discuss --start --members "<w1>,<w2>" --topic "<question>"')
      }

      const memberList = members.split(',').map((m) => m.trim()).filter(Boolean)
      const response = await postJson(baseUrl, '/api/team/discuss/start', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        members: memberList,
        topic,
        ...(rounds ? { rounds } : {}),
        ...(listenMode ? { listen_mode: listenMode } : {}),
        ...(orchJoin ? { orch_participates: true } : {}),
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // --end: end discussion (default: summarize; --cancel: no report)
    if (args.includes('--end')) {
      let reason: string | undefined
      const cancel = args.includes('--cancel')
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--reason' && args[i + 1]) { reason = args[++i]; continue }
      }
      const response = await postJson(baseUrl, '/api/team/discuss/end', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        ...(reason ? { reason } : {}),
        ...(cancel ? { cancel: true } : {}),
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // --skip: skip a worker
    if (args.includes('--skip')) {
      const skipIndex = args.indexOf('--skip')
      const workerName = args[skipIndex + 1]
      if (!workerName || workerName.startsWith('--')) {
        throw new Error('Usage: team discuss --skip <worker-name>')
      }
      const response = await postJson(baseUrl, '/api/team/discuss/skip', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        worker_name: workerName,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // --steer: inject guidance into discussion
    if (args.includes('--steer')) {
      const steerIndex = args.indexOf('--steer')
      const text = args[steerIndex + 1]
      if (!text || text.startsWith('--')) {
        throw new Error('Usage: team discuss --steer "<direction>"')
      }
      const response = await postJson(baseUrl, '/api/team/discuss/steer', {
        workspace_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        text,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // --extend: add more rounds
    if (args.includes('--extend')) {
      const extendIndex = args.indexOf('--extend')
      const nextArg = args[extendIndex + 1]
      const rounds = nextArg && !nextArg.startsWith('--') ? Number(nextArg) : 1
      const response = await postJson(baseUrl, '/api/team/discuss/extend', {
        workspace_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        rounds,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // --final: submit final position
    if (args.includes('--final')) {
      const finalIndex = args.indexOf('--final')
      const text = args[finalIndex + 1]
      if (!text || text.startsWith('--')) {
        throw new Error('Usage: team discuss --final "<final-position>"')
      }
      const response = await postJson(baseUrl, '/api/team/discuss/final', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        text,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    // No flag: send discussion message (positional arg)
    const text = args.filter((a) => !a.startsWith('--')).join(' ').trim()
    if (!text) {
      throw new Error('Usage: team discuss "<message>"')
    }
    const response = await postJson(baseUrl, '/api/team/discuss/message', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      text,
    })
    console.log(JSON.stringify(await response.json()))
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
