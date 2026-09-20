import { IntegrationError } from './errors.js'

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  confidence?: number
  probabilities?: Record<string, number>
}

export interface NoulAnswer {
  type: 'noul'
  noul: number
}

export interface ScoreAnswer {
  type: 'score'
  score: number
}

export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer

export interface JevResult {
  answers: Record<string, JevAnswer>
  usage?: unknown
}

interface CallJevOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function callJev(
  state: unknown,
  questions: Record<string, unknown>,
  options: CallJevOptions = {}
): Promise<JevResult> {
  const apiKey = (options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '').trim()
  if (!apiKey) {
    throw new IntegrationError(
      'typesafe_key_missing',
      'TYPESAFE_API_KEY is required; no action was executed.'
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(
      options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? process.env.TYPESAFE_MODEL ?? 'jev-latest',
          state,
          questions,
        }),
        signal: controller.signal,
      }
    )
    if (!response.ok) {
      throw new IntegrationError(
        'typesafe_http_error',
        `TypeSafe returned HTTP ${response.status}; no action was executed.`
      )
    }
    let result: unknown
    try {
      result = await response.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new IntegrationError(
          'typesafe_invalid_json',
          'TypeSafe returned invalid JSON; no action was executed.',
          { cause: error }
        )
      }
      throw error
    }
    if (!isRecord(result) || !isRecord(result.answers)) {
      throw new IntegrationError(
        'typesafe_invalid_response',
        'TypeSafe returned an invalid response; no action was executed.'
      )
    }
    return result as unknown as JevResult
  } catch (error) {
    if (timedOut) {
      throw new IntegrationError(
        'typesafe_timeout',
        'TypeSafe request timed out; no action was executed.',
        { cause: error }
      )
    }
    if (error instanceof TypeError) {
      throw new IntegrationError(
        'typesafe_network_error',
        'TypeSafe could not be reached; no action was executed.',
        { cause: error }
      )
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
