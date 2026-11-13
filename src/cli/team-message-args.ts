import type { DispatchMessageKind } from '../shared/team-collaboration.js'

export const MESSAGE_USAGE =
  'team message --dispatch <id> --kind note|question|answer|progress [--from-dispatch <id>] [--to orchestrator] [--reply-to <id>] (<text> | --stdin)'

export const parseSequence = (value: string, flag: string): number => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} requires a non-negative safe integer`)
  }
  return Number(value)
}

export const parseOptions = (
  args: string[],
  allowed: Set<string>,
  repeatable = new Set<string>()
) => {
  const options = new Map<string, string>()
  const repeated = new Map<string, string[]>()
  const positionals: string[] = []
  let positionalOnly = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (!positionalOnly && arg === '--') {
      positionalOnly = true
      continue
    }
    if (positionalOnly || !arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const flag = equals < 0 ? arg : arg.slice(0, equals)
    if (!allowed.has(flag)) throw new Error(`Unknown argument: ${arg}`)
    if (options.has(flag) && !repeatable.has(flag)) throw new Error(`Duplicate argument: ${arg}`)
    if (
      flag === '--stdin' ||
      flag === '--list' ||
      flag === '--ephemeral' ||
      flag === '--success' ||
      flag === '--failed'
    ) {
      if (equals >= 0) throw new Error(`${flag} does not take a value`)
      options.set(flag, 'true')
      continue
    }
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1)
    if (!value?.trim() || (equals < 0 && value.startsWith('-') && !/^-[0-9]/.test(value)))
      throw new Error(`${flag} requires a value`)
    options.set(flag, value)
    if (repeatable.has(flag)) repeated.set(flag, [...(repeated.get(flag) ?? []), value])
  }
  return { options, positionals, repeated }
}

export const parseSendArgs = (args: string[]) => {
  const { options, positionals } = parseOptions(args, new Set(['--related-to']))
  const [memberName, ...body] = positionals
  const text = body.join(' ').trim()
  if (!memberName?.trim() || !text)
    throw new Error('Usage: team send <member-name> <task> [--related-to <id>]')
  return { memberName, text, relatedToDispatchId: options.get('--related-to') }
}

export const parseMessageArgs = (args: string[]) => {
  const { options, positionals } = parseOptions(
    args,
    new Set(['--dispatch', '--from-dispatch', '--to', '--kind', '--reply-to', '--stdin'])
  )
  const dispatchId = options.get('--dispatch')
  const kind = options.get('--kind')
  if (!dispatchId || !kind || !['note', 'question', 'answer', 'progress'].includes(kind))
    throw new Error(`Usage: ${MESSAGE_USAGE}`)
  const recipient = options.get('--to')
  if (recipient !== undefined && recipient !== 'orchestrator')
    throw new Error('--to only accepts orchestrator; omit it to address the dispatch owner')
  const useStdin = options.has('--stdin')
  if (
    (useStdin && positionals.length !== 0) ||
    (!useStdin && (positionals.length !== 1 || !positionals[0]?.trim()))
  )
    throw new Error(`Expected exactly one message body or --stdin. Usage: ${MESSAGE_USAGE}`)
  const replyTo = options.get('--reply-to')
  if (kind === 'answer' && !replyTo) throw new Error('answer requires --reply-to <message-id>')
  return {
    dispatchId,
    kind: kind as DispatchMessageKind,
    recipient,
    sourceDispatchId: options.get('--from-dispatch'),
    replyTo,
    useStdin,
    text: positionals[0],
  }
}

export const parseMessagesArgs = (args: string[]) => {
  const { options, positionals } = parseOptions(args, new Set(['--dispatch', '--after']))
  const dispatchId = options.get('--dispatch')
  if (!dispatchId || positionals.length)
    throw new Error('Usage: team messages --dispatch <id> [--after <sequence>]')
  const after = options.get('--after')
  return { dispatchId, afterSeq: after === undefined ? undefined : parseSequence(after, '--after') }
}
