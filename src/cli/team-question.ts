import { setTimeout } from 'node:timers/promises'
import { parseMessageArgs, parseOptions, parseSequence } from './team-message-args.js'

export const ASK_USAGE =
  'team ask --dispatch <id> [--to orchestrator] [--from-dispatch <id>] (<question> | --stdin) [--wait <0..60 seconds>]'
export const RESUME_USAGE = 'team ask --resume <question-id> [--wait <0..60 seconds>]'
export const QUESTION_HISTORY_USAGE = 'team ask --list [--dispatch <id>] [--before <question-id>]'
export const REPLY_USAGE = 'team reply <question-id> (<answer> | --stdin)'
type Post = (path: string, body: object, signal?: AbortSignal) => Promise<Response>

interface QuestionResult {
  status: 'pending' | 'answered' | 'closed'
  question: { id: string }
  answers: unknown[]
}

/** One model/tool invocation, bounded authenticated reads; never retries a write. */
const waitForTeamResult = async <T>(
  read: (signal: AbortSignal) => Promise<T>,
  ready: (result: T) => boolean,
  seconds: number
) => {
  const deadline = performance.now() + seconds * 1000
  let result = await read(AbortSignal.timeout(seconds > 0 ? Math.min(5000, seconds * 1000) : 5000))
  while (!ready(result) && performance.now() < deadline) {
    await setTimeout(Math.min(1000, Math.max(0, deadline - performance.now())))
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(5000, remaining))))
    try {
      result = await read(signal)
    } catch (error) {
      // Preserve the last snapshot only when the wait budget expired. Other
      // transport and authorization failures still reach the caller.
      if (!signal.aborted || performance.now() < deadline) throw error
      break
    }
  }
  return { result, timedOut: seconds > 0 && !ready(result) }
}

export const runQuestionCommand = async (
  command: 'ask' | 'reply',
  args: string[],
  post: Post,
  readStdin: () => Promise<string>
) => {
  if (command === 'reply') {
    const { options, positionals } = parseOptions(args, new Set(['--stdin']))
    const [questionId, ...body] = positionals
    if (
      !questionId?.trim() ||
      (options.has('--stdin') ? body.length !== 0 : body.length !== 1 || !body[0]?.trim())
    )
      throw new Error(`Usage: ${REPLY_USAGE}`)
    const text = options.has('--stdin') ? await readStdin() : body[0]
    const response = await post('/api/team/reply', { question_id: questionId, text })
    console.log(JSON.stringify(await response.json()))
    return
  }
  const { options, positionals } = parseOptions(
    args,
    new Set([
      '--dispatch',
      '--from-dispatch',
      '--to',
      '--stdin',
      '--wait',
      '--resume',
      '--list',
      '--before',
    ])
  )
  if (options.has('--list')) {
    if (
      positionals.length ||
      [...options.keys()].some((key) => !['--list', '--dispatch', '--before'].includes(key))
    )
      throw new Error(`Usage: ${QUESTION_HISTORY_USAGE}`)
    console.log(
      JSON.stringify(
        await (
          await post('/api/team/questions', {
            ...(options.has('--dispatch') ? { dispatch_id: options.get('--dispatch') } : {}),
            ...(options.has('--before') ? { before_id: options.get('--before') } : {}),
          })
        ).json()
      )
    )
    return
  }
  const wait = options.get('--wait')
  const seconds = wait === undefined ? 0 : parseSequence(wait, '--wait')
  if (seconds > 60) throw new Error('--wait must be between 0 and 60 seconds')
  let questionId = options.get('--resume')
  if (questionId) {
    if (
      positionals.length ||
      [...options.keys()].some((key) => key !== '--resume' && key !== '--wait')
    )
      throw new Error(`Resume only reads the existing question. Usage: ${RESUME_USAGE}`)
  } else {
    // Reuse the established message parser, including body and peer-routing validation.
    const messageArgs = ['--kind', 'question']
    for (const [key, value] of options) {
      if (key === '--wait') continue
      messageArgs.push(key)
      if (key !== '--stdin') messageArgs.push(value)
    }
    messageArgs.push('--', ...positionals)
    const parsed = parseMessageArgs(messageArgs)
    const response = await post('/api/team/message', {
      dispatch_id: parsed.dispatchId,
      kind: 'question',
      text: parsed.useStdin ? await readStdin() : parsed.text,
      ...(parsed.sourceDispatchId ? { source_dispatch_id: parsed.sourceDispatchId } : {}),
      ...(parsed.recipient ? { recipient: parsed.recipient } : {}),
    })
    const saved = (await response.json()) as { message: { id: string } }
    questionId = saved.message.id
    console.error(
      `Question saved: ${questionId}. Resume without resending: team ask --resume ${questionId}`
    )
  }
  const { result, timedOut } = await waitForTeamResult(
    async (signal) =>
      (await (
        await post('/api/team/question', { question_id: questionId }, signal)
      ).json()) as QuestionResult,
    (value) => value.status !== 'pending',
    seconds
  )
  console.log(
    JSON.stringify({
      ...result,
      question_id: questionId,
      timed_out: timedOut,
      resume: `team ask --resume ${questionId}`,
    })
  )
}
