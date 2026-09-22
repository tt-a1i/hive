import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_COMMAND_PRESET_CLI_LIST } from '../server/command-preset-defaults.js'
import {
  buildProtocolGuide,
  isProtocolGuideTopic,
  PROTOCOL_GUIDE_TOPICS,
} from '../server/hive-team-guidance.js'
import { sameFilesystemPath } from '../server/path-canonicalization.js'
import {
  isMemoryKind,
  isMemoryProcedureRefType,
  isMemoryScope,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_PROCEDURE_REF_ID_MAX_CHARS,
  MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS,
  MEMORY_PROCEDURE_REF_TYPES,
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_SCOPES,
  MEMORY_SEARCH_MAX_LIMIT,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TAG_MAX_COUNT,
  type MemoryKind,
  type MemoryProcedureRef,
  type MemoryScope,
} from '../shared/team-memory.js'
import { RECALL_QUERY_MAX_CHARS } from '../shared/team-recall.js'
import { isTeamReviewRole, type TeamReviewRole } from '../shared/types.js'
import {
  MESSAGE_USAGE,
  parseMessageArgs,
  parseMessagesArgs,
  parseSendArgs,
  parseSequence,
} from './team-message-args.js'
import {
  ASK_USAGE,
  DELEGATE_USAGE,
  INBOX_USAGE,
  QUESTION_HISTORY_USAGE,
  REPLY_USAGE,
  RESUME_USAGE,
  runDelegateCommand,
  runInboxCommand,
  runQuestionCommand,
  waitForTeamResult,
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
  '  team memory add "<body>" [--kind fact|preference|decision|pitfall|procedure_ref] [--scope workspace|user] [--tag <tag>] [--ref-type workflow|skill|procedure|template|doc --ref-id <id> [--ref-title <title>]]',
  '  team memory show <memory-id>',
  '  team memory search "<query>" [--limit <n>] [--scope workspace|user|all]',
  '  team memory dream show <dream-run-id>',
  '  team memory apply --run <dream-run-id> --stdin',
  '  team memory forget <memory-id>',
  '  team send <member-name> "<task>" [--related-to <dispatch-id>]',
  `  ${MESSAGE_USAGE}`,
  '  team messages --dispatch <id> [--after <sequence>] [--wait <0..60 seconds>]',
  `  ${ASK_USAGE}`,
  `  ${RESUME_USAGE}`,
  `  ${QUESTION_HISTORY_USAGE}`,
  `  ${REPLY_USAGE}`,
  `  ${INBOX_USAGE}`,
  `  ${DELEGATE_USAGE}`,
  '  team peers',
  `  team spawn <role> [--name <name>] [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--ephemeral]`,
  `  team review [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--role reviewer|tester] [--model <model>] [--name <name>] ("<focus>" | --stdin)`,
  '  team dismiss <member-name>',
  '  team cancel --dispatch <dispatch-id> "<reason>"',
  '  team goal report --goal <goal-id> --status progress|done|blocked|failed "<body>"',
  '  team goal report --goal <goal-id> --status progress|done|blocked|failed --stdin',
  '  team report "<result>" [--dispatch <dispatch-id>] [--seen <sequence>] [--ack <batch-id>] [--success | --failed] [--artifact <path>]',
  '  team report --stdin [--dispatch <dispatch-id>] [--seen <sequence>] [--ack <batch-id>] [--success | --failed] [--artifact <path>]',
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
  'For focused runtime guidance, use team guide <topic>. For the full generated protocol, see .hive/PROTOCOL.md',
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

// Read `--flag value` from an argv slice; returns undefined when absent or
// when the flag is the last token with no following value.
const readFlag = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

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

interface TeamGoalReportResponse {
  cursor: number
  goal_id: string
  ok: true
  status: string
}

interface ParsedCancelArgs {
  dispatchId: string
  reason: string
}

const REPORT_USAGE =
  'Usage: team report (<result> | --stdin) [--dispatch <dispatch-id>] [--ack <batch-id>] [--seen <sequence>] [--success | --failed] [--artifact <path>]'
const STATUS_USAGE = 'Usage: team status (<current status> | --stdin) [--artifact <path>]'
const CANCEL_USAGE = 'Usage: team cancel --dispatch <dispatch-id> <reason>'
const REVIEW_USAGE = `Usage: team review [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--role reviewer|tester] [--model <model>] [--name <name>] ("<focus>" | --stdin)`
const GUIDE_USAGE = `Usage: team guide <${PROTOCOL_GUIDE_TOPICS.join('|')}>`
const RECALL_USAGE = 'Usage: team recall "<query>" [--limit <n>] [--window <n>]'
const MEMORY_ADD_USAGE =
  'Usage: team memory add "<body>" [--kind fact|preference|decision|pitfall|procedure_ref] [--scope workspace|user] [--tag <tag>] [--ref-type workflow|skill|procedure|template|doc --ref-id <id> [--ref-title <title>]]'
const MEMORY_SHOW_USAGE = 'Usage: team memory show <memory-id>'
const MEMORY_SEARCH_USAGE =
  'Usage: team memory search "<query>" [--limit <n>] [--scope workspace|user|all]'
const MEMORY_DREAM_SHOW_USAGE = 'Usage: team memory dream show <dream-run-id>'
const MEMORY_APPLY_USAGE = 'Usage: team memory apply --run <dream-run-id> --stdin'
const MEMORY_FORGET_USAGE = 'Usage: team memory forget <memory-id>'
const GOAL_REPORT_USAGE =
  'Usage: team goal report --goal <goal-id> --status progress|done|blocked|failed (<body> | --stdin) [--artifact <path>]'

const GOAL_REPORT_STATUSES = new Set(['progress', 'done', 'blocked', 'failed'])

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
      `Hive recorded the ${action}. Delivery to the responsible recipient is queued${detail}`
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

const readGeneratedProtocolGuide = (topic: string): string | null => {
  const protocolPath = join(process.cwd(), '.hive', 'PROTOCOL.md')
  if (!existsSync(protocolPath)) return null
  const doc = readFileSync(protocolPath, 'utf8')
  const marker = `## Guide: ${topic}`
  const start = doc.indexOf(marker)
  if (start === -1) return null
  const nextGuide = doc.indexOf('\n## Guide:', start + marker.length)
  const reminders = doc.indexOf('\n## In-message reminders', start + marker.length)
  const candidates = [nextGuide, reminders].filter((index) => index !== -1)
  const end = candidates.length === 0 ? doc.length : Math.min(...candidates)
  return doc.slice(start, end).trimEnd()
}

export interface ParsedReportArgs {
  ackBatchId?: string
  outcome?: 'success' | 'failed'
  artifacts: string[]
  dispatchId: string | undefined
  seenSeq?: number
  result: string | null
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let dispatchId: string | undefined
  let seenSeq: number | undefined
  let useStdin = false
  let ackBatchId: string | undefined
  let outcome: 'success' | 'failed' | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--success' || arg === '--failed') {
      if (command !== 'report' || outcome)
        throw new Error(withUsage('Invalid or duplicate outcome', command))
      outcome = arg === '--success' ? 'success' : 'failed'
      continue
    }
    if (arg === '--ack') {
      const value = args[++index]
      if (command !== 'report' || ackBatchId || !value?.trim() || value.startsWith('--'))
        throw new Error(withUsage('--ack requires one batch ID', command))
      ackBatchId = value
      continue
    }

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

    if (arg === '--seen') {
      if (command !== 'report' || seenSeq !== undefined)
        throw new Error(withUsage('Invalid or duplicate --seen', command))
      const value = args[index + 1]
      if (value === undefined) throw new Error(withUsage('--seen requires a value', command))
      seenSeq = parseSequence(value, '--seen')
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      if (dispatchId !== undefined) throw new Error(withUsage('Duplicate --dispatch', command))
      if (command === 'status') {
        throw new Error(
          withUsage(
            'team status does not accept --dispatch; record task progress with team message --dispatch <id> --to orchestrator --kind progress "<update>". Use team report only when ending the responsibility.',
            command
          )
        )
      }
      const next = args[index + 1]
      if (next === undefined || !next.trim() || next.startsWith('--')) {
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

  if (seenSeq !== undefined && !dispatchId)
    throw new Error(withUsage('--seen requires --dispatch', command))
  return {
    result: useStdin ? null : (positionals[0] ?? null),
    artifacts,
    dispatchId,
    useStdin,
    ...(seenSeq !== undefined ? { seenSeq } : {}),
    ...(ackBatchId ? { ackBatchId } : {}),
    ...(outcome ? { outcome } : {}),
  }
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
  const positionals: string[] = []
  let cli: string | undefined
  let model: string | undefined
  let name: string | undefined
  let role: TeamReviewRole | undefined
  let useStdin = false

  const readValue = (flag: string, index: number) => {
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} requires a value\n\n${REVIEW_USAGE}`)
    }
    return next
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }
    if (arg === '--cli') {
      cli = readValue('--cli', index)
      index += 1
      continue
    }
    if (arg === '--model') {
      model = readValue('--model', index)
      index += 1
      continue
    }
    if (arg === '--name') {
      name = readValue('--name', index)
      index += 1
      continue
    }
    if (arg === '--role') {
      const value = readValue('--role', index)
      if (!isTeamReviewRole(value)) {
        throw new TeamUsageError(
          'REVIEW_INVALID_ROLE',
          `--role must be reviewer or tester\n\n${REVIEW_USAGE}`
        )
      }
      role = value
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${REVIEW_USAGE}`)
    }
    positionals.push(arg)
  }

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
    ...(role ? { role } : {}),
  }
}

export interface ParsedGoalReportArgs {
  artifacts: string[]
  goalId: string
  result: string | null
  status: 'progress' | 'done' | 'blocked' | 'failed'
  useStdin: boolean
}

export const parseGoalReportArgs = (args: string[]): ParsedGoalReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let goalId: string | undefined
  let status: ParsedGoalReportArgs['status'] | undefined
  let useStdin = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg === '--goal') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--goal requires a value\n\n${GOAL_REPORT_USAGE}`)
      }
      goalId = next
      index += 1
      continue
    }

    if (arg === '--status') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--status requires a value\n\n${GOAL_REPORT_USAGE}`)
      }
      if (!GOAL_REPORT_STATUSES.has(next)) {
        throw new Error(
          `--status must be one of: progress, done, blocked, failed\n\n${GOAL_REPORT_USAGE}`
        )
      }
      status = next as ParsedGoalReportArgs['status']
      index += 1
      continue
    }

    if (arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--artifact requires a value\n\n${GOAL_REPORT_USAGE}`)
      }
      artifacts.push(next)
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${GOAL_REPORT_USAGE}`)
    }

    positionals.push(arg)
  }

  if (!goalId) throw new Error(`Missing --goal <goal-id>\n\n${GOAL_REPORT_USAGE}`)
  if (!status) throw new Error(`Missing --status <status>\n\n${GOAL_REPORT_USAGE}`)
  if (useStdin && positionals.length > 0) {
    throw new Error(
      `--stdin is mutually exclusive with a positional body; pass the body on stdin or as an argument, not both\n\n${GOAL_REPORT_USAGE}`
    )
  }
  if (!useStdin && positionals.length === 0) {
    throw new Error(
      `Missing <body> (or pass --stdin to read it from stdin)\n\n${GOAL_REPORT_USAGE}`
    )
  }
  if (positionals.length > 1) {
    throw new Error(
      `Expected exactly one body positional, got ${positionals.length}: ${positionals
        .map((value) => JSON.stringify(value))
        .join(', ')}\n\n${GOAL_REPORT_USAGE}`
    )
  }

  return {
    artifacts,
    goalId,
    result: useStdin ? null : (positionals[0] ?? null),
    status,
    useStdin,
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
  const positionals: string[] = []
  let limit: number | undefined
  let window: number | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--limit' || arg === '--window') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value\n\n${RECALL_USAGE}`)
      }
      if (arg === '--limit') limit = parseNonNegativeIntFlag(next, '--limit')
      else window = parseNonNegativeIntFlag(next, '--window')
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${RECALL_USAGE}`)
    }

    positionals.push(arg)
  }

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

export interface ParsedMemoryAddArgs {
  body: string
  kind: MemoryKind
  procedureRef: MemoryProcedureRef | null
  scope: MemoryScope
  tags: string[]
}

export const parseMemoryAddArgs = (args: string[]): ParsedMemoryAddArgs => {
  const positionals: string[] = []
  const tags: string[] = []
  let kind: MemoryKind = 'fact'
  let procedureRefId: string | undefined
  let procedureRefTitle: string | null = null
  let procedureRefType: MemoryProcedureRef['type'] | undefined
  let scope: MemoryScope = 'workspace'

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--kind') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--kind requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      if (!isMemoryKind(next)) {
        throw new Error(`--kind must be one of: ${MEMORY_KINDS.join(', ')}\n\n${MEMORY_ADD_USAGE}`)
      }
      kind = next
      index += 1
      continue
    }

    if (arg === '--scope') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--scope requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      if (!isMemoryScope(next)) {
        throw new Error(
          `--scope must be one of: ${MEMORY_SCOPES.join(', ')}\n\n${MEMORY_ADD_USAGE}`
        )
      }
      scope = next
      index += 1
      continue
    }

    if (arg === '--ref-type') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--ref-type requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      if (!isMemoryProcedureRefType(next)) {
        throw new Error(
          `--ref-type must be one of: ${MEMORY_PROCEDURE_REF_TYPES.join(', ')}\n\n${MEMORY_ADD_USAGE}`
        )
      }
      procedureRefType = next
      index += 1
      continue
    }

    if (arg === '--ref-id') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--ref-id requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      const refId = next.trim()
      if (!refId) throw new Error(`--ref-id requires a non-empty value\n\n${MEMORY_ADD_USAGE}`)
      if ([...refId].length > MEMORY_PROCEDURE_REF_ID_MAX_CHARS) {
        throw new Error(
          `--ref-id must be ${MEMORY_PROCEDURE_REF_ID_MAX_CHARS} characters or fewer\n\n${MEMORY_ADD_USAGE}`
        )
      }
      procedureRefId = refId
      index += 1
      continue
    }

    if (arg === '--ref-title') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--ref-title requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      const refTitle = next.trim()
      if ([...refTitle].length > MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS) {
        throw new Error(
          `--ref-title must be ${MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS} characters or fewer\n\n${MEMORY_ADD_USAGE}`
        )
      }
      procedureRefTitle = refTitle || null
      index += 1
      continue
    }

    if (arg === '--tag') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--tag requires a value\n\n${MEMORY_ADD_USAGE}`)
      }
      const tag = next.trim()
      if (!tag) {
        throw new Error(`--tag requires a non-empty value\n\n${MEMORY_ADD_USAGE}`)
      }
      if ([...tag].length > MEMORY_TAG_MAX_CHARS) {
        throw new Error(
          `--tag must be ${MEMORY_TAG_MAX_CHARS} characters or fewer\n\n${MEMORY_ADD_USAGE}`
        )
      }
      if (!tags.includes(tag)) tags.push(tag)
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${MEMORY_ADD_USAGE}`)
    }

    positionals.push(arg)
  }

  if (tags.length > MEMORY_TAG_MAX_COUNT) {
    throw new Error(
      `--tag may be repeated ${MEMORY_TAG_MAX_COUNT} times or fewer\n\n${MEMORY_ADD_USAGE}`
    )
  }

  if (positionals.length === 0) {
    throw new Error(`Missing <body>\n\n${MEMORY_ADD_USAGE}`)
  }

  const body = positionals.join(' ').trim()
  if (!body) {
    throw new Error(`Missing <body>\n\n${MEMORY_ADD_USAGE}`)
  }
  if ([...body].length > MEMORY_BODY_MAX_CHARS) {
    throw new Error(
      `body must be ${MEMORY_BODY_MAX_CHARS} characters or fewer\n\n${MEMORY_ADD_USAGE}`
    )
  }

  if (
    (procedureRefType || procedureRefId || procedureRefTitle) &&
    (!procedureRefType || !procedureRefId)
  ) {
    throw new Error(`--ref-type and --ref-id must be provided together\n\n${MEMORY_ADD_USAGE}`)
  }

  const procedureRef =
    procedureRefType && procedureRefId
      ? { id: procedureRefId, title: procedureRefTitle, type: procedureRefType }
      : null
  if (kind === 'procedure_ref' && !procedureRef) {
    throw new Error(`--kind procedure_ref requires --ref-type and --ref-id\n\n${MEMORY_ADD_USAGE}`)
  }

  return {
    body,
    kind,
    procedureRef,
    scope,
    tags,
  }
}

export const parseMemoryShowArgs = (args: string[]) => {
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
    throw new Error(`Missing <memory-id>\n\n${MEMORY_SHOW_USAGE}`)
  }
  return { memoryId: args[0] }
}

export const parseMemorySearchArgs = (args: string[]) => {
  const positionals: string[] = []
  let limit: number | undefined
  let scope: MemoryScope | 'all' = 'workspace'

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--limit') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--limit requires a value\n\n${MEMORY_SEARCH_USAGE}`)
      }
      const parsed = Number(next)
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--limit must be a non-negative integer\n\n${MEMORY_SEARCH_USAGE}`)
      }
      limit = Math.min(parsed, MEMORY_SEARCH_MAX_LIMIT)
      index += 1
      continue
    }

    if (arg === '--scope') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--scope requires a value\n\n${MEMORY_SEARCH_USAGE}`)
      }
      if (next !== 'all' && !isMemoryScope(next)) {
        throw new Error(`--scope must be workspace, user, or all\n\n${MEMORY_SEARCH_USAGE}`)
      }
      scope = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${MEMORY_SEARCH_USAGE}`)
    }

    positionals.push(arg)
  }

  if (positionals.length === 0) {
    throw new Error(`Missing <query>\n\n${MEMORY_SEARCH_USAGE}`)
  }
  const query = positionals.join(' ').trim()
  if (!query) {
    throw new Error(`Missing <query>\n\n${MEMORY_SEARCH_USAGE}`)
  }
  if ([...query].length > MEMORY_QUERY_MAX_CHARS) {
    throw new Error(
      `query must be ${MEMORY_QUERY_MAX_CHARS} characters or fewer\n\n${MEMORY_SEARCH_USAGE}`
    )
  }

  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    scope,
  }
}

export const parseMemoryDreamShowArgs = (args: string[]) => {
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
    throw new Error(`Missing <dream-run-id>\n\n${MEMORY_DREAM_SHOW_USAGE}`)
  }
  return { runId: args[0] }
}

export const parseMemoryApplyArgs = (args: string[]) => {
  const positionals: string[] = []
  let runId: string | undefined
  let useStdin = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--run') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--run requires a value\n\n${MEMORY_APPLY_USAGE}`)
      }
      runId = next
      index += 1
      continue
    }

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${MEMORY_APPLY_USAGE}`)
    }

    positionals.push(arg)
  }

  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument\n\n${MEMORY_APPLY_USAGE}`)
  }
  if (!runId) {
    throw new Error(`Missing --run <dream-run-id>\n\n${MEMORY_APPLY_USAGE}`)
  }
  if (!useStdin) {
    throw new Error(`Missing --stdin\n\n${MEMORY_APPLY_USAGE}`)
  }
  return { runId }
}

export const parseMemoryApplyPayload = (value: string): unknown => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(
      `stdin must be valid JSON; got: ${error instanceof Error ? error.message : String(error)}\n\n${MEMORY_APPLY_USAGE}`
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stdin JSON must be an object with an ops array\n\n${MEMORY_APPLY_USAGE}`)
  }
  const ops = (parsed as { ops?: unknown }).ops
  if (!Array.isArray(ops)) {
    throw new Error(`stdin JSON must include an ops array\n\n${MEMORY_APPLY_USAGE}`)
  }
  return ops
}

export const parseMemoryForgetArgs = (args: string[]) => {
  if (args.length === 0 || !args[0] || args[0].startsWith('--')) {
    throw new Error(`Missing <memory-id>\n\n${MEMORY_FORGET_USAGE}`)
  }
  if (args.length !== 1) {
    throw new Error(`Expected exactly one <memory-id>\n\n${MEMORY_FORGET_USAGE}`)
  }
  return { memoryId: args[0] }
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
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
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

  if (command === 'guide') {
    const topic = args[0]
    if (!topic || !isProtocolGuideTopic(topic)) {
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
      const saved = readGeneratedProtocolGuide(topic)
      const reference =
        saved ??
        (topic === 'workflow'
          ? '## Guide: workflow\nWorkflow availability and CLI policy are unknown. Run `team guide workflow` inside a Hive member terminal to read the current configuration before authoring or running a workflow.'
          : buildProtocolGuide(topic))
      console.log(
        `${saved ? 'Saved' : 'Offline'} reference only: no authenticated Hive workspace. Any saved feature state may be stale; current capabilities are unknown. Run this command inside a Hive member terminal for live guidance.\n\n${reference}`
      )
    }
    return
  }

  if (command === 'next') {
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

  if (command === 'memory') {
    const [subcommand, ...memoryArgs] = args
    if (subcommand === 'add') {
      const memory = parseMemoryAddArgs(memoryArgs)
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/add', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        body: memory.body,
        kind: memory.kind,
        procedure_ref: memory.procedureRef,
        scope: memory.scope,
        tags: memory.tags,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'show') {
      const memory = parseMemoryShowArgs(memoryArgs)
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/show', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        memory_id: memory.memoryId,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'search') {
      const memory = parseMemorySearchArgs(memoryArgs)
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/search', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        query: memory.query,
        ...(memory.limit !== undefined ? { limit: memory.limit } : {}),
        scope: memory.scope,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'dream') {
      const [dreamSubcommand, ...dreamArgs] = memoryArgs
      if (dreamSubcommand !== 'show') {
        throw new Error(MEMORY_DREAM_SHOW_USAGE)
      }
      const dream = parseMemoryDreamShowArgs(dreamArgs)
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/dream/show', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        run_id: dream.runId,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'apply') {
      const apply = parseMemoryApplyArgs(memoryArgs)
      const ops = parseMemoryApplyPayload(
        await readStdinToString('memory apply', MEMORY_APPLY_USAGE)
      )
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/apply', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        run_id: apply.runId,
        ops,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    if (subcommand === 'forget') {
      const memory = parseMemoryForgetArgs(memoryArgs)
      const env = getHiveEnv()
      const response = await postJson(getBaseUrl(env), '/api/team/memory/forget', {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        memory_id: memory.memoryId,
      })
      console.log(JSON.stringify(await response.json()))
      return
    }

    throw new Error(
      [
        'Usage:',
        `  ${MEMORY_ADD_USAGE}`,
        `  ${MEMORY_SHOW_USAGE}`,
        `  ${MEMORY_SEARCH_USAGE}`,
        `  ${MEMORY_DREAM_SHOW_USAGE}`,
        `  ${MEMORY_APPLY_USAGE}`,
        `  ${MEMORY_FORGET_USAGE}`,
      ].join('\n')
    )
  }

  if (
    command === 'delegate' ||
    command === 'peers' ||
    command === 'inbox' ||
    command === 'ask' ||
    command === 'reply' ||
    command === 'message' ||
    command === 'messages'
  ) {
    const env = getHiveEnv()
    const identity = {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
    }
    const post = (path: string, body: object, signal?: AbortSignal) =>
      postJson(getBaseUrl(env), path, { ...identity, ...body }, signal ?? AbortSignal.timeout(5000))
    if (command === 'delegate') {
      await runDelegateCommand(args, post, () => readStdinToString('delegate', DELEGATE_USAGE))
      return
    }
    if (command === 'peers') {
      if (args.length) throw new Error('Usage: team peers')
      console.log(
        JSON.stringify(await (await postJson(getBaseUrl(env), '/api/team/peers', identity)).json())
      )
      return
    }
    if (command === 'inbox') {
      await runInboxCommand(args, post)
      return
    }
    if (command === 'ask' || command === 'reply') {
      await runQuestionCommand(command, args, post, () =>
        readStdinToString(command, command === 'ask' ? ASK_USAGE : REPLY_USAGE)
      )
      return
    }
    if (command === 'messages') {
      const parsed = parseMessagesArgs(args)
      const { result, timedOut } = await waitForTeamResult(
        async (signal) => {
          const response = await postJson(
            getBaseUrl(env),
            '/api/team/messages',
            {
              ...identity,
              dispatch_id: parsed.dispatchId,
              ...(parsed.afterSeq !== undefined ? { after_seq: parsed.afterSeq } : {}),
            },
            signal
          )
          return (await response.json()) as {
            messages: unknown[]
            related_dispatches: { id: string; state: string }[]
          }
        },
        (value) =>
          value.messages.length > 0 ||
          value.related_dispatches.some(
            (item) =>
              item.id === parsed.dispatchId &&
              (item.state === 'reported' || item.state === 'cancelled')
          ),
        parsed.waitSeconds
      )
      console.log(
        JSON.stringify({ ...result, ...(parsed.waitSeconds ? { timed_out: timedOut } : {}) })
      )
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
    const role = args[0]
    if (!role || role.startsWith('--')) {
      throw new Error(
        `Usage: team spawn <role> [--name <name>] [--cli <${BUILTIN_COMMAND_PRESET_CLI_LIST}>] [--ephemeral]\n` +
          '  Default: persistent member (lives until you `team dismiss` it).\n' +
          '  --ephemeral: auto-dismiss after the next dispatch report (one-shot member).'
      )
    }
    const name = readFlag(args, '--name')
    const cli = readFlag(args, '--cli')
    const ephemeral = args.includes('--ephemeral')
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
    const memberName = args[0]
    if (!memberName || memberName.startsWith('--')) {
      throw new Error('Usage: team dismiss <member-name>')
    }
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
      const inlineFlag = rest.indexOf('--inline')
      const stdinFlag = rest.includes('--stdin')
      const name = readFlag(rest, '--name')
      // TIER 2 #8 — `--args '<JSON>'` makes the script's `args` global a
      // real value instead of always undefined. Parses lazily so a bad
      // JSON gives a clear local error before the HTTP round-trip.
      const rawArgs = readFlag(rest, '--args')
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
      let source: string
      if (inlineFlag !== -1) {
        const literal = rest[inlineFlag + 1]
        if (!literal) throw new Error('Usage: team workflow run --inline "<script-source>"')
        source = literal
      } else if (stdinFlag) {
        source = await readStdinToString('workflow run')
      } else {
        throw new Error(
          'Usage: team workflow run --stdin   |   team workflow run --inline "<script-source>"\n' +
            '  Pass workflow source via stdin (POSIX heredoc / `type x.ts |`) or as one inline arg.\n' +
            "  Optional: --args '<JSON>' makes the script's `args` global a real value."
        )
      }
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
      const runId = rest[0]
      if (!runId) throw new Error('Usage: team workflow stop <run-id>')
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
      const runId = rest[0]
      if (!runId) throw new Error('Usage: team workflow show <run-id>')
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
      const inlineFlag = rest.indexOf('--inline')
      const stdinFlag = rest.includes('--stdin')
      const cron = readFlag(rest, '--cron')
      const name = readFlag(rest, '--name')
      if (!cron || !name) throw new Error(usage)
      const rawArgs = readFlag(rest, '--args')
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
      let source: string
      if (inlineFlag !== -1) {
        const literal = rest[inlineFlag + 1]
        if (!literal) throw new Error(usage)
        source = literal
      } else if (stdinFlag) {
        source = await readStdinToString('workflow schedule')
      } else {
        throw new Error(usage)
      }
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
        '  Note: workflow commands are experimental and may be disabled in this workspace; re-read .hive/PROTOCOL.md for the enabled command set.'
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

  if (command === 'goal') {
    const [subcommand, ...goalArgs] = args
    if (subcommand !== 'report') {
      throw new Error(GOAL_REPORT_USAGE)
    }
    const report = parseGoalReportArgs(goalArgs)
    const body = report.useStdin
      ? await readStdinToString('goal report', GOAL_REPORT_USAGE)
      : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/goal/report', {
      artifacts: report.artifacts,
      from_agent_id: env.HIVE_AGENT_ID,
      goal_id: report.goalId,
      project_id: env.HIVE_PROJECT_ID,
      result: body,
      status: report.status,
      token: env.HIVE_AGENT_TOKEN,
    })
    const payload = (await response.json()) as TeamGoalReportResponse
    console.log(
      JSON.stringify({ goal_id: payload.goal_id, cursor: payload.cursor, status: payload.status })
    )
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
      ...(report.ackBatchId ? { ack_batch_id: report.ackBatchId } : {}),
      ...(report.outcome ? { status: report.outcome } : {}),
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
