import { ORCHESTRATOR_PRINCIPLES } from '../shared/orchestrator-principles.js'

/** Codex supplies identity in per-call metadata, never model-controlled arguments. */
export const readControllerThreadId = (metadata: unknown): string => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Codex App session metadata is required. Connect from the App conversation.')
  }
  const meta = metadata as Record<string, unknown>
  let turnMeta = meta['x-codex-turn-metadata']
  if (typeof turnMeta === 'string') turnMeta = JSON.parse(turnMeta)
  const nested =
    turnMeta && typeof turnMeta === 'object' && !Array.isArray(turnMeta)
      ? (turnMeta as Record<string, unknown>).thread_id
      : undefined
  if (meta.threadId !== undefined && nested !== undefined && meta.threadId !== nested) {
    throw new Error('Conflicting Codex App session metadata')
  }
  const threadId = meta.threadId ?? nested
  if (
    typeof threadId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)
  ) {
    throw new Error(
      'Valid Codex App session metadata is required; do not supply a thread ID as an argument.'
    )
  }
  return threadId
}

export const CONTROLLER_TOOL_NAMES = ['hive.controller_connect', 'hive.controller_action'] as const

export const CONTROLLER_TOOLS = [
  {
    name: 'hive.controller_connect',
    description:
      'Request binding of THIS Codex App conversation as the sole controller of an external-mode Hive workspace. The user must confirm the request in Hive before you can manage members. The host supplies your conversation identity; never ask the user to type a thread ID. After confirmation, call controller_action inspect before choosing work.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', minLength: 1 } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'hive.controller_action',
    description:
      ORCHESTRATOR_PRINCIPLES.join('\n') +
      '\nManage the workspace bound to THIS Codex App conversation. At a new task or after losing context, inspect first. For unfamiliar action syntax, historical questions, or uncertain delivery, read action guide. send creates responsibility; message exchanges within it. Mutations send/message/reply/spawn/start/stop/cancel require one operation_id per intended operation, reused on retries; inspect uncertain outcomes before retrying. Answer questions with reply question_id, text and operation_id. read_reports receives notifications; ack_reports consumes report_ids already read, independently of answering or accepting work. ack never closes a dispatch or advances a member seen sequence. After dispatch, continue independent work or finish the turn; actionable results trigger notifications. Ignore already acknowledged notification IDs; end an empty read without polling or redispatching.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', minLength: 1 },
        action: {
          type: 'string',
          enum: [
            'guide',
            'inspect',
            'send',
            'message',
            'messages',
            'question',
            'reply',
            'spawn',
            'start',
            'stop',
            'cancel',
            'read_reports',
            'ack_reports',
          ],
        },
        operation_id: { type: 'string', minLength: 1 },
        worker_name: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        role: { type: 'string', enum: ['coder', 'reviewer', 'tester', 'custom'] },
        cli: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        dispatch_id: { type: 'string', minLength: 1 },
        related_to_dispatch_id: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: ['note', 'question', 'answer'] },
        reply_to: { type: 'string', minLength: 1 },
        question_id: { type: 'string', minLength: 1 },
        after_seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        reason: { type: 'string', minLength: 1 },
        report_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true },
      },
      required: ['workspace_id', 'action'],
      additionalProperties: false,
    },
  },
] as const

const ACTION_FIELDS: Record<string, string[]> = {
  guide: [],
  inspect: [],
  send: ['operation_id', 'worker_name', 'text', 'related_to_dispatch_id'],
  message: ['operation_id', 'dispatch_id', 'kind', 'text', 'reply_to'],
  messages: ['dispatch_id', 'after_seq'],
  question: ['question_id'],
  reply: ['operation_id', 'question_id', 'text'],
  spawn: ['operation_id', 'role', 'cli', 'name'],
  start: ['operation_id', 'worker_name'],
  stop: ['operation_id', 'worker_name'],
  cancel: ['operation_id', 'dispatch_id', 'reason'],
  read_reports: [],
  ack_reports: ['report_ids'],
}

export const validateControllerArguments = (toolName: string, args: Record<string, unknown>) => {
  const fields =
    toolName === 'hive.controller_connect'
      ? ['workspace_id']
      : ['workspace_id', 'action', ...(ACTION_FIELDS[String(args.action)] ?? [])]
  if (
    toolName !== 'hive.controller_connect' &&
    !Object.hasOwn(ACTION_FIELDS, String(args.action))
  ) {
    throw new Error('Unsupported controller action')
  }
  for (const key of Object.keys(args)) {
    if (!fields.includes(key)) throw new Error(`Unexpected controller argument: ${key}`)
  }
  for (const field of fields) {
    if (field === 'report_ids') continue
    if (
      ['name', 'related_to_dispatch_id', 'reply_to', 'after_seq'].includes(field) &&
      args[field] === undefined
    )
      continue
    if (field === 'after_seq') {
      if (typeof args[field] !== 'number' || !Number.isSafeInteger(args[field]) || args[field] < 0)
        throw new Error('after_seq must be a non-negative safe integer')
      continue
    }
    if (typeof args[field] !== 'string' || !(args[field] as string).trim()) {
      throw new Error(`Missing ${field}`)
    }
  }
  if (args.action === 'message') {
    if (!['note', 'question', 'answer'].includes(String(args.kind)))
      throw new Error('Unsupported message kind')
    if (args.kind === 'answer' && args.reply_to === undefined)
      throw new Error('answer requires reply_to')
  }
  if (args.action === 'ack_reports') {
    if (
      !Array.isArray(args.report_ids) ||
      !args.report_ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ) {
      throw new Error('report_ids must contain positive integer report IDs')
    }
  }
}

export const requireLocalControllerRuntime = (baseUrl: string) => {
  const url = new URL(baseUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Codex App controller mode requires a local HTTP Hive runtime origin')
  }
}
