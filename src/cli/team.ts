import { fileURLToPath } from 'node:url'
import { BUILTIN_COMMAND_PRESET_CLI_LIST } from '../server/command-preset-defaults.js'
import {
  buildProtocolGuide,
  isProtocolGuideTopic,
  PROTOCOL_GUIDE_TOPICS,
} from '../server/hive-team-guidance.js'
import { sameFilesystemPath } from '../server/path-canonicalization.js'
import { RECALL_QUERY_MAX_CHARS } from '../shared/team-recall.js'
import { isTeamReviewRole, type TeamReviewRole } from '../shared/types.js'
import {
  MESSAGE_USAGE,
  parseMessageArgs,
  parseMessagesArgs,
  parseOptions,
  parseSendArgs,
  parseSequence,
} from './team-message-args.js'

import {
  ASK_USAGE,
  QUESTION_HISTORY_USAGE,
  REPLY_USAGE,
  RESUME_USAGE,
  runQuestionCommand,
} from './team-question.js'

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
  `  team guide <${PROTOCOL_GUIDE_TOPICS.join('|')}>`,
  '  team next   (tasks in .hive/tasks.md that are unblocked now — those whose [needs: #n] deps are all done)',
  '  team recall "<query>" [--limit <n>] [--window <n>]',
  '  team send <member-name> "<task>" [--related-to <dispatch-id>]',
  `  ${MESSAGE_USAGE}`,
  `  ${ASK_USAGE}`,
  `  ${RESUME_USAGE}`,
  `  ${QUESTION_HISTORY_USAGE}`,
  `  ${REPLY_USAGE}`,
  '  team messages --dispatch <id> [--after <sequence>]',
  `  team spawn <role> [--name <name>] [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--ephemeral]`,
  `  team review [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--role reviewer|tester] [--model <model>] [--name <name>] ("<focus>" | --stdin)`,
  '  team dismiss <member-name>',
  '  team cancel --dispatch <dispatch-id> "<reason>"',
  '  team report "<result>" [--dispatch <dispatch-id>] [--seen <sequence>] [--artifact <path>]',
  '  team report --stdin [--dispatch <dispatch-id>] [--seen <sequence>] [--artifact <path>]',
  '  team status "<current status>" [--artifact <path>]  (optional readiness note; never closes a dispatch)',
  '  team status --stdin [--artifact <path>]',
  '',
  'Flags can appear in any order. Use --stdin to pipe long bodies and avoid shell-escaping issues.',
  'The body comes from stdin — use whatever your shell supports:',
  "  POSIX:        team report --stdin --dispatch <id> <<'EOF'",
  '                ... long report ...',
  '                EOF',
  '  Windows cmd:  type body.txt | team report --stdin --dispatch <id>',
  '  PowerShell:   Get-Content -Raw -Encoding utf8 body.txt | team report --stdin --dispatch <id>',
  '  Portable:     team report --stdin --dispatch <id> < body.txt',
  '',
  'For focused runtime guidance, use team guide <topic>.',
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

const postJson = async (baseUrl: string, path: string, body: unknown, signal?: AbortSignal) => {
  const response = await fetchRuntime(baseUrl, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    ...(signal ? { signal } : {}),
  })

  if (!response.ok) {
    await throwHttpError(response)
  }

  return response
}

interface TeamReportResponse {
  delivery_state?: 'delivered' | 'delivering' | 'queued' | 'failed' | null
  dispatch_id: string | null
  forward_error?: string | null
  forwarded?: boolean
  ok: true
  pending_warning?: string | null
}

interface ParsedCancelArgs {
  dispatchId: string
  reason: string
}

const REPORT_USAGE =
  'Usage: team report (<result> | --stdin) [--dispatch <dispatch-id>] [--seen <sequence>] [--artifact <path>]'
const STATUS_USAGE = 'Usage: team status (<current status> | --stdin) [--artifact <path>]'
const CANCEL_USAGE = 'Usage: team cancel --dispatch <dispatch-id> <reason>'
const REVIEW_USAGE = `Usage: team review [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--role reviewer|tester] [--model <model>] [--name <name>] ("<focus>" | --stdin)`
const GUIDE_USAGE = `Usage: team guide <${PROTOCOL_GUIDE_TOPICS.join('|')}>`
const RECALL_USAGE = 'Usage: team recall "<query>" [--limit <n>] [--window <n>]'
const usageFor = (command: string) => (command === 'status' ? STATUS_USAGE : REPORT_USAGE)

const withUsage = (message: string, command: string) => `${message}\n\n${usageFor(command)}`

const printOrchestratorDeliveryWarning = (
  action: 'report' | 'status update',
  payload: TeamReportResponse
) => {
  if (payload.delivery_state === 'delivered' || payload.delivery_state === 'delivering') return
  if (payload.delivery_state === 'queued') {
    const detail = payload.forward_error ? `: ${payload.forward_error}` : '.'
    console.error(
      `Hive recorded the ${action}, but Orchestrator did not receive it in real time. It is queued for durable delivery${detail}`
    )
    return
  }
  if (payload.delivery_state === 'failed') {
    const detail = payload.forward_error ? `: ${payload.forward_error}` : '.'
    console.error(
      `Hive recorded the ${action}, but could not deliver it to Orchestrator or confirm durable queueing${detail}`
    )
    return
  }
  if (payload.forwarded === false && payload.forward_error) {
    console.error(
      `Hive recorded the ${action}, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
    )
  }
}

export interface ParsedReportArgs {
  artifacts: string[]
  dispatchId: string | undefined
  seenSeq?: number
  result: string | null
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(
      args,
      new Set(['--stdin', '--success', '--failed', '--artifact', '--dispatch', '--seen']),
      new Set(['--artifact'])
    )
  } catch (error) {
    throw new Error(withUsage(error instanceof Error ? error.message : String(error), command))
  }
  const { options, positionals, repeated } = parsed
  const artifacts = repeated.get('--artifact') ?? []
  const dispatchId = options.get('--dispatch')
  const seen = options.get('--seen')
  const useStdin = options.has('--stdin')
  if (command === 'status' && dispatchId)
    throw new Error(
      withUsage(
        'team status does not accept --dispatch; use team report to end the responsibility.',
        command
      )
    )
  if (command !== 'report' && seen !== undefined)
    throw new Error(withUsage('Invalid --seen', command))
  const seenSeq = seen === undefined ? undefined : parseSequence(seen, '--seen')

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

  if (seenSeq !== undefined && !dispatchId)
    throw new Error(withUsage('--seen requires --dispatch', command))
  return {
    result: useStdin ? null : (positionals[0] ?? null),
    artifacts,
    dispatchId,
    useStdin,
    ...(seenSeq !== undefined ? { seenSeq } : {}),
  }
}

export const parseCancelArgs = (args: string[]): ParsedCancelArgs => {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(args, new Set(['--dispatch']))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${CANCEL_USAGE}`)
  }
  const { options, positionals } = parsed
  const dispatchId = options.get('--dispatch')

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

export class TeamUsageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TeamUsageError'
    this.code = code
  }
}

export interface ParsedReviewArgs {
  cli?: string
  focus: string | null
  model?: string
  name?: string
  role?: TeamReviewRole
  useStdin: boolean
}

export const parseReviewArgs = (args: string[]): ParsedReviewArgs => {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(args, new Set(['--stdin', '--cli', '--model', '--name', '--role']))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${REVIEW_USAGE}`)
  }
  const { options, positionals } = parsed
  const cli = options.get('--cli')
  const model = options.get('--model')
  const name = options.get('--name')
  const role = options.get('--role')
  const useStdin = options.has('--stdin')
  if (role && !isTeamReviewRole(role))
    throw new TeamUsageError(
      'REVIEW_INVALID_ROLE',
      `--role must be reviewer or tester\n\n${REVIEW_USAGE}`
    )

  if (useStdin && positionals.length > 0) {
    throw new TeamUsageError(
      'REVIEW_STDIN_EXCLUSIVE',
      `--stdin is mutually exclusive with a positional argument; pass the focus on stdin or as an argument, not both\n\n${REVIEW_USAGE}`
    )
  }
  if (!useStdin && positionals.length === 0) {
    throw new TeamUsageError(
      'REVIEW_MISSING_FOCUS',
      `Missing <focus> (or pass --stdin to read it from stdin)\n\n${REVIEW_USAGE}`
    )
  }
  if (positionals.length > 1) {
    throw new Error(
      `Expected exactly one focus positional, got ${positionals.length}\n\n${REVIEW_USAGE}`
    )
  }

  const focus = useStdin ? null : (positionals[0] ?? null)
  if (!useStdin && !focus?.trim()) {
    throw new TeamUsageError(
      'REVIEW_MISSING_FOCUS',
      `Missing <focus> (or pass --stdin to read it from stdin)\n\n${REVIEW_USAGE}`
    )
  }

  return {
    focus,
    useStdin,
    ...(cli ? { cli } : {}),
    ...(model ? { model } : {}),
    ...(name ? { name } : {}),
    ...(role && isTeamReviewRole(role) ? { role } : {}),
  }
}

const parseNonNegativeIntFlag = (value: string | undefined, flag: string) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer\n\n${RECALL_USAGE}`)
  }
  return parsed
}

export const parseRecallArgs = (args: string[]) => {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(args, new Set(['--limit', '--window']))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${RECALL_USAGE}`)
  }
  const { options, positionals } = parsed
  const limit = parseNonNegativeIntFlag(options.get('--limit'), '--limit')
  const window = parseNonNegativeIntFlag(options.get('--window'), '--window')

  if (positionals.length === 0) {
    throw new Error(`Missing <query>\n\n${RECALL_USAGE}`)
  }
  const query = positionals.join(' ').trim()
  if ([...query].length > RECALL_QUERY_MAX_CHARS) {
    throw new Error(
      `query must be ${RECALL_QUERY_MAX_CHARS} characters or fewer\n\n${RECALL_USAGE}`
    )
  }

  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(window !== undefined ? { window } : {}),
  }
}

export const decodeStdinBuffer = (buffer: Buffer): string => {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return buffer.toString('utf8')
}

export const readStdinToString = async (
  command = 'report',
  usage = usageFor(command)
): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      `--stdin requires piped input, but stdin is a TTY. Did you forget to pipe content in?\n\n${usage}`
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  const maxBytes = 1024 * 1024
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error(`--stdin exceeds ${maxBytes} bytes\n\n${usage}`)
    chunks.push(buffer)
  }
  const content = decodeStdinBuffer(Buffer.concat(chunks))
  if (!content.trim()) {
    throw new Error(`--stdin received empty input\n\n${usage}`)
  }
  return content
}

export const runTeamCommand = async (argv: string[]) => {
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TEAM_USAGE)
    return
  }

  const beforeDelimiter = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
  if (beforeDelimiter.includes('--help') || beforeDelimiter.includes('-h')) {
    const prefix =
      command === 'workflow' && args[0] && !args[0].startsWith('-')
        ? `team workflow ${args[0]}`
        : `team ${command}`
    const lines = TEAM_USAGE.split('\n').filter(
      (line) => line.trimStart() === prefix || line.trimStart().startsWith(`${prefix} `)
    )
    const workflowUsage: Record<string, string> = {
      run: 'Usage: team workflow run (--stdin | --inline <source>) [--name <name>] [--args <JSON>]',
      schedule:
        'Usage: team workflow schedule --cron <cron> --name <name> (--stdin | --inline <source>) [--args <JSON>]',
      show: 'Usage: team workflow show <run-id>',
      stop: 'Usage: team workflow stop <run-id>',
    }
    console.log(
      command === 'workflow'
        ? (workflowUsage[args[0] ?? ''] ?? 'Usage: team workflow <run|schedule|show|stop>')
        : lines.length
          ? `Usage:\n${lines.join('\n')}`
          : `Usage: ${prefix}`
    )
    return
  }

  if (command === 'ask' || command === 'reply') {
    const env = getHiveEnv()
    await runQuestionCommand(
      command,
      args,
      (path, body, signal) =>
        postJson(
          getBaseUrl(env),
          path,
          {
            ...body,
            project_id: env.HIVE_PROJECT_ID,
            from_agent_id: env.HIVE_AGENT_ID,
            token: env.HIVE_AGENT_TOKEN,
          },
          signal
        ),
      () => readStdinToString(command, `Usage: ${command === 'ask' ? ASK_USAGE : REPLY_USAGE}`)
    )
    return
  }

  if (command === 'list') {
    if (args.length) throw new Error('Usage: team list')
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

  if (command === 'guide') {
    const topic = args[0]
    if (args.length !== 1 || !topic || !isProtocolGuideTopic(topic)) {
      throw new Error(GUIDE_USAGE)
    }
    if (REQUIRED_ENV_KEYS.some((key) => process.env[key] !== undefined)) {
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/guide', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        topic,
      })
      const result = (await response.json()) as {
        project_id: string
        project_path: string
        guide: string
      }
      console.log(
        `Live Hive guide — project_id: ${result.project_id}\nProject path: ${JSON.stringify(result.project_path)}\n\n${result.guide}`
      )
    } else {
      const reference =
        topic === 'workflow'
          ? '## Guide: workflow\nWorkflow availability and CLI policy are unknown. Run `team guide workflow` inside a Hive member terminal to read the current configuration before authoring or running a workflow.'
          : buildProtocolGuide(topic)
      console.log(
        `Offline reference only: no authenticated Hive workspace. Current capabilities are unknown. Run this command inside a Hive member terminal for live guidance.\n\n${reference}`
      )
    }
    return
  }

  if (command === 'next') {
    if (args.length) throw new Error('Usage: team next')
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(
      baseUrl,
      `/api/workspaces/${env.HIVE_PROJECT_ID}/tasks/next`,
      {
        method: 'GET',
        headers: {
          'x-hive-agent-id': env.HIVE_AGENT_ID,
          'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
        },
      }
    )

    if (!response.ok) {
      await throwHttpError(response)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'recall') {
    const recall = parseRecallArgs(args)
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/recall', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      query: recall.query,
      ...(recall.limit !== undefined ? { limit: recall.limit } : {}),
      ...(recall.window !== undefined ? { window: recall.window } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'message' || command === 'messages') {
    const env = getHiveEnv()
    const identity = {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
    }
    if (command === 'messages') {
      const parsed = parseMessagesArgs(args)
      const response = await postJson(getBaseUrl(env), '/api/team/messages', {
        ...identity,
        dispatch_id: parsed.dispatchId,
        ...(parsed.afterSeq !== undefined ? { after_seq: parsed.afterSeq } : {}),
      })
      console.log(JSON.stringify(await response.json()))
    } else {
      const parsed = parseMessageArgs(args)
      const text = parsed.useStdin ? await readStdinToString('message', MESSAGE_USAGE) : parsed.text
      const response = await postJson(getBaseUrl(env), '/api/team/message', {
        ...identity,
        dispatch_id: parsed.dispatchId,
        kind: parsed.kind,
        text,
        ...(parsed.sourceDispatchId ? { source_dispatch_id: parsed.sourceDispatchId } : {}),
        ...(parsed.recipient ? { recipient: parsed.recipient } : {}),
        ...(parsed.replyTo ? { reply_to: parsed.replyTo } : {}),
      })
      console.log(JSON.stringify(await response.json()))
    }
    return
  }

  if (command === 'send') {
    const { memberName, text: task, relatedToDispatchId } = parseSendArgs(args)

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/send', {
      hive_port: env.HIVE_PORT,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      to: memberName,
      text: task,
      ...(relatedToDispatchId ? { related_to_dispatch_id: relatedToDispatchId } : {}),
    })
    const payload = (await response.json()) as {
      dispatch_id: string
      ok: true
      restarted_worker?: boolean
      queued?: boolean
      worker_status?: string
    }
    /* When the dispatch happened to also auto-wake a stopped member
       (PTY had no active run), make the silent restart visible. Stderr
       is the right channel because the JSON on stdout is the
       machine-readable payload; the human-readable narration goes
       beside it so it doesn't corrupt parsers. */
    if (payload.restarted_worker === true) {
      console.error(`Hive woke up member "${memberName}" before dispatching.`)
    }
    if (payload.queued === true) {
      console.error(
        `Member "${memberName}" is stopped — the dispatch is queued and will be delivered automatically when the member is next started. ` +
          'Tell the user to start it in the Hive UI if this should run now, or `team cancel --dispatch <id>` to reassign.'
      )
    }
    console.log(JSON.stringify(payload))
    return
  }

  if (command === 'spawn') {
    const { options, positionals } = parseOptions(args, new Set(['--name', '--cli', '--ephemeral']))
    const role = positionals[0]
    if (!role || positionals.length !== 1)
      throw new Error('Usage: team spawn <role> [--name <name>] [--cli <cli>] [--ephemeral]')
    const name = options.get('--name')
    const cli = options.get('--cli')
    const ephemeral = options.has('--ephemeral')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/spawn', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      role,
      ...(name ? { name } : {}),
      ...(cli ? { cli } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'review') {
    const parsed = parseReviewArgs(args)
    const focus = parsed.useStdin
      ? await readStdinToString('review', REVIEW_USAGE)
      : (parsed.focus ?? '')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/review', {
      workspace_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      focus,
      ...(parsed.cli ? { cli: parsed.cli } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.role ? { role: parsed.role } : {}),
    })
    const payload = (await response.json()) as {
      cli: string
      dispatch_id: string
      member_name: string
      role: string
    }
    console.log(JSON.stringify(payload))
    return
  }

  if (command === 'dismiss') {
    const { positionals } = parseOptions(args, new Set())
    const memberName = positionals[0]
    if (!memberName || positionals.length !== 1)
      throw new Error('Usage: team dismiss <member-name>')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/dismiss', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      name: memberName,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'workflow') {
    const sub = args[0]
    const rest = args.slice(1)
    if (sub === 'run') {
      const { options, positionals } = parseOptions(
        rest,
        new Set(['--inline', '--stdin', '--name', '--args'])
      )
      if (positionals.length || options.has('--inline') === options.has('--stdin'))
        throw new Error(
          'Usage: team workflow run (--inline <source> | --stdin) [--name <name>] [--args <JSON>]'
        )
      const inline = options.get('--inline')
      const name = options.get('--name')
      // TIER 2 #8 — `--args '<JSON>'` makes the script's `args` global a
      // real value instead of always undefined. Parses lazily so a bad
      // JSON gives a clear local error before the HTTP round-trip.
      const rawArgs = options.get('--args')
      let parsedArgs: unknown | undefined
      if (rawArgs !== undefined) {
        try {
          parsedArgs = JSON.parse(rawArgs)
        } catch (error) {
          throw new Error(
            `Usage: team workflow run … --args '<JSON>'\n  --args must be valid JSON; got: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      const source = inline ?? (await readStdinToString('workflow run'))
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/workflow/run', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        source,
        ...(name ? { name } : {}),
        ...(parsedArgs !== undefined ? { args: parsedArgs } : {}),
      })
      console.log(JSON.stringify(await response.json()))
      return
    }
    if (sub === 'stop') {
      const { positionals } = parseOptions(rest, new Set())
      const runId = positionals[0]
      if (!runId || positionals.length !== 1) throw new Error('Usage: team workflow stop <run-id>')
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/workflow/stop', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        run_id: runId,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }
    if (sub === 'show') {
      const { positionals } = parseOptions(rest, new Set())
      const runId = positionals[0]
      if (!runId || positionals.length !== 1) throw new Error('Usage: team workflow show <run-id>')
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/workflow/show', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        run_id: runId,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }
    if (sub === 'schedule') {
      const usage =
        'Usage: team workflow schedule --cron "<5-field cron>" --name <name> --stdin\n' +
        '       team workflow schedule --cron "<cron>" --name <name> --inline "<source>" [--args \'<JSON>\']\n' +
        '  Registers a recurring run. Source is persisted so cron can fire it with no orchestrator present.'
      const { options, positionals } = parseOptions(
        rest,
        new Set(['--inline', '--stdin', '--cron', '--name', '--args'])
      )
      if (positionals.length || options.has('--inline') === options.has('--stdin'))
        throw new Error(usage)
      const inline = options.get('--inline')
      const cron = options.get('--cron')
      const name = options.get('--name')
      if (!cron || !name) throw new Error(usage)
      const rawArgs = options.get('--args')
      let parsedArgs: unknown | undefined
      if (rawArgs !== undefined) {
        try {
          parsedArgs = JSON.parse(rawArgs)
        } catch (error) {
          throw new Error(
            `Usage: team workflow schedule … --args '<JSON>'\n  --args must be valid JSON; got: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      const source = inline ?? (await readStdinToString('workflow schedule'))
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/workflow/schedule', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        source,
        name,
        cron,
        ...(parsedArgs !== undefined ? { args: parsedArgs } : {}),
      })
      console.log(JSON.stringify(await response.json()))
      return
    }
    throw new Error(
      'Usage:\n' +
        "  team workflow run --stdin [--args '<JSON>']     (read script from stdin)\n" +
        '  team workflow run --inline "<source>" [--args ...]  (one-arg form)\n' +
        '  team workflow stop <run-id>                     (cancel a running workflow)\n' +
        '  team workflow show <run-id>                     (full per-agent transcript)\n' +
        '  team workflow schedule --cron "<cron>" --name <n> --stdin   (register a recurring run)\n' +
        '  Note: workflow commands are experimental and may be disabled in this workspace; run team guide workflow for the enabled command set.'
    )
  }

  if (command === 'cancel') {
    const cancel = parseCancelArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/cancel', {
      dispatch_id: cancel.dispatchId,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      reason: cancel.reason,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `Hive cancelled the dispatch in the ledger, but could not deliver the cancel notice to the member: ${payload.forward_error}. The member may still be acting on the task.`
      )
    }
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
    printOrchestratorDeliveryWarning('status update', payload)
    if (payload.pending_warning) console.error(payload.pending_warning)
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)
    const body = report.useStdin ? await readStdinToString('report') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/report', {
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      ...(report.seenSeq !== undefined ? { seen_seq: report.seenSeq } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: body,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    printOrchestratorDeliveryWarning('report', payload)
    if (payload.pending_warning) console.error(payload.pending_warning)
    return
  }

  throw new Error('Unsupported team command')
}

const isMainModule = process.argv[1]
  ? sameFilesystemPath(fileURLToPath(import.meta.url), process.argv[1])
  : false

if (isMainModule) {
  void runTeamCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
