import { parseMessageArgs, parseOptions, parseSequence } from './team-message-args.js'

export const ASK_USAGE =
  'team ask [--dispatch <id>] [--to orchestrator] [--from-dispatch <id>] (<question> | --stdin) [--wait <0..60 seconds>]'
export const RESUME_USAGE = 'team ask --resume <question-id> [--wait <0..60 seconds>]'
export const QUESTION_HISTORY_USAGE = 'team ask --list [--dispatch <id>] [--before <question-id>]'
export const REPLY_USAGE = 'team reply <question-id> (<answer> | --stdin)'
type Post = (path: string, body: object, signal?: AbortSignal) => Promise<Response>

interface QuestionResult {
  status: 'pending' | 'answered' | 'closed'
  question: { id: string; recipient_agent_id: string }
  answers: Array<{ text: string }>
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
  const seconds = wait === undefined ? 60 : parseSequence(wait, '--wait')
  if (seconds > 60) throw new Error('--wait must be between 0 and 60 seconds')
  let questionId = options.get('--resume')
  if (questionId) {
    if (
      positionals.length ||
      [...options.keys()].some((key) => key !== '--resume' && key !== '--wait')
    )
      throw new Error(`Resume only reads the existing question. Usage: ${RESUME_USAGE}`)
  } else {
    const peer = options.has('--from-dispatch')
    let body: object
    if (peer) {
      const messageArgs = ['--kind', 'question']
      for (const [key, value] of options) {
        if (key === '--wait') continue
        messageArgs.push(key)
        if (key !== '--stdin') messageArgs.push(value)
      }
      messageArgs.push('--', ...positionals)
      const parsed = parseMessageArgs(messageArgs)
      body = {
        dispatch_id: parsed.dispatchId,
        source_dispatch_id: parsed.sourceDispatchId,
        ...(parsed.recipient ? { recipient: parsed.recipient } : {}),
        kind: 'question',
        text: parsed.useStdin ? await readStdin() : parsed.text,
      }
    } else {
      if (
        [...options.keys()].some(
          (key) => !['--dispatch', '--to', '--stdin', '--wait'].includes(key)
        ) ||
        (options.has('--to') && options.get('--to') !== 'orchestrator') ||
        (options.has('--stdin')
          ? positionals.length !== 0
          : positionals.length !== 1 || !positionals[0]?.trim())
      )
        throw new Error(`Usage: ${ASK_USAGE}`)
      body = {
        ...(options.has('--dispatch') ? { dispatch_id: options.get('--dispatch') } : {}),
        ...(options.has('--to') ? { recipient: options.get('--to') } : {}),
        text: options.has('--stdin') ? await readStdin() : positionals[0],
      }
    }
    const response = await post(peer ? '/api/team/message' : '/api/team/ask', body)
    const saved = (await response.json()) as { message: { id: string } }
    questionId = saved.message.id
    console.error(
      `Question saved: ${questionId}. Resume without resending: team ask --resume ${questionId}`
    )
  }
  const interrupted = new AbortController()
  const onInterrupt = () => interrupted.abort()
  process.on('SIGINT', onInterrupt)
  try {
    // A single authenticated read waits on the server. The write above is never retried.
    const signal = AbortSignal.any([
      interrupted.signal,
      AbortSignal.timeout(seconds * 1000 + 10000),
    ])
    const result = (await (
      await post('/api/team/question', { question_id: questionId, wait_ms: seconds * 1000 }, signal)
    ).json()) as QuestionResult
    const directAnswer =
      !options.has('--resume') &&
      !options.has('--from-dispatch') &&
      seconds > 0 &&
      result.status === 'answered' &&
      result.question.recipient_agent_id === `${process.env.HIVE_PROJECT_ID}:orchestrator` &&
      result.answers.length > 0
    if (directAnswer) {
      console.log(result.answers.map((answer) => answer.text).join('\n'))
      return
    }
    console.log(
      JSON.stringify({
        ...result,
        question_id: questionId,
        timed_out: seconds > 0 && result.status === 'pending',
        resume: `team ask --resume ${questionId}`,
      })
    )
  } catch (error) {
    if (!interrupted.signal.aborted) throw error
    console.error(`Wait interrupted. Question preserved. Resume: team ask --resume ${questionId}`)
    console.log(
      JSON.stringify({
        question_id: questionId,
        interrupted: true,
        resume: `team ask --resume ${questionId}`,
      })
    )
    process.exitCode = 130
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}
