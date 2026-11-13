import type { AgentManager } from './agent-manager.js'
import { BUILTIN_INTERACTIVE_COMMANDS } from './command-preset-defaults.js'
import { PromptReadinessTimeoutError } from './http-errors.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

const READY_CHECK_INTERVAL_MS = 50
const READY_TIMEOUT_MS = 3000
const PROMPT_READY_HARD_TIMEOUT_MS = 30000
const PROMPT_READY_TAIL_CHARS = 8000
const OUTPUT_SCAN_LIMIT = 16384
const OPENCODE_COMPLETION_READY_SETTLE_MS = 1000
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 600
const CODEX_PASTE_ACK_SETTLE_DELAY_MS = 600
const PASTE_ACK_TIMEOUT_MS = 3000
const CLAUDE_HIVE_PASTE_ACK_TIMEOUT_MS = 10000
const CLAUDE_HIVE_PASTE_ACK_MIN_CHARS = 2000
// Codex can take several seconds to render "[Pasted Content ...]" on Windows
// conpty for large bracketed-paste payloads. Claude gets the longer window only
// on Windows and only for large Hive envelopes; small prompts need the shorter
// fallback so a CLI that does not render paste acknowledgements still receives
// Enter promptly.
const CODEX_PASTE_ACK_TIMEOUT_MS = 10000
// Codex only emits "[Pasted Content ...]" for sufficiently large pastes. Short
// Hive report/status/user-input payloads are usually rendered literally in the
// input box, so waiting for an acknowledgement there degrades into the 10s
// timeout before Enter is sent.
const CODEX_PASTE_ACK_MIN_CHARS = 2000
const CODEX_SUBMIT_RETRY_DELAY_MS = 500
const GROK_SUBMIT_AFTER_PASTE_DELAY_MS = 100
const OPENCODE_MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 2500
const OPENCODE_MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 5000
const OPENCODE_PASTE_CHARS_PER_DELAY_MS = 2
const GEMINI_STYLE_MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 4000
const GEMINI_STYLE_PASTE_CHARS_PER_DELAY_MS = 2
const COMMANDS_WITH_BRACKETED_PASTE = new Set([
  'agy',
  'claude',
  'codex',
  'grok',
  'hermes',
  'kimi',
  'opencode',
  'pi',
])
const COMMANDS_WAITING_FOR_PASTE_ACK = new Set(['claude', 'codex'])
const BRACKETED_PASTE_END = '\u001b[201~'
const PASTE_ACK_PATTERN =
  /(?:^|[\r\n])\s*(?:[❯›]\s*)?\[(?:Pasted text #\d+[^\]]*|Pasted Content [\d,]+ chars)\]/u
const PASTE_ACK_ONLY_DELTA_PATTERN =
  /^[\s\r\n]*(?:[❯›]\s*)?\[(?:Pasted text #\d+[^\]]*|Pasted Content [\d,]+ chars)\]\s*(?:[❯›]\s*)?$/u
const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
const TERMINAL_CONTROL_PATTERN = new RegExp(
  `${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`,
  'gu'
)
const HIVE_ACK_GATED_MESSAGE_PATTERN =
  /<(?:hive-system-message\b|hive-message\s+kind="(?:cancel|dispatch|heartbeat|startup)"(?:\s|>))/u
const OPENCODE_VISIBLE_PROMPT_PATTERN = /\bAsk anything\.\.\./u
const OPENCODE_COMPLETED_TURN_FOOTER_PATTERN = /^▣\s+[^·\n]+·\s+\S.*\s+·\s+\d+(?:\.\d+)?(?:ms|s)$/u
const OPENCODE_INTERRUPT_STATUS_PATTERN = /\besc\s+interrupt\b/iu

const BRACKETED_PASTE_START = '\u001b[200~'

export const toBracketedPasteSubmission = (text: string) => {
  const body = text.replaceAll(BRACKETED_PASTE_END, '').replaceAll(BRACKETED_PASTE_START, '')
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
const createRunInactiveError = (runId: string) =>
  new Error(`Run became inactive before input was submitted: ${runId}`)

const getSubmitAfterPasteDelayMs = (command: string, text: string) => {
  const commandName = getCommandName(command)
  if (commandName === 'grok') return GROK_SUBMIT_AFTER_PASTE_DELAY_MS
  if (commandName === 'opencode') {
    return Math.min(
      OPENCODE_MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
      Math.max(
        OPENCODE_MIN_SUBMIT_AFTER_PASTE_DELAY_MS,
        Math.ceil(text.length / OPENCODE_PASTE_CHARS_PER_DELAY_MS)
      )
    )
  }
  if (commandName === 'gemini' || commandName === 'qwen') {
    return Math.min(
      GEMINI_STYLE_MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
      Math.max(
        MIN_SUBMIT_AFTER_PASTE_DELAY_MS,
        Math.ceil(text.length / GEMINI_STYLE_PASTE_CHARS_PER_DELAY_MS)
      )
    )
  }
  return Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )
}

const getCommandName = (command: string) => normalizeExecutableToken(command) ?? ''

export const isInteractiveAgentCommand = (command: string) => {
  const brand = normalizeExecutableToken(command)
  return brand !== null && BUILTIN_INTERACTIVE_COMMANDS.has(brand)
}

const getPlainTerminalOutput = (output: string) =>
  output.slice(-OUTPUT_SCAN_LIMIT).replace(/\r/g, '\n').replace(TERMINAL_CONTROL_PATTERN, '')
const getPlainTerminalTail = (output: string) =>
  getPlainTerminalOutput(output).slice(-PROMPT_READY_TAIL_CHARS)
const getRecentNonEmptyTerminalLines = (output: string): string[] =>
  getPlainTerminalTail(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
const hasGeminiPromptReady = (output: string) => /\bType your message\b/u.test(output)
const hasHermesPromptReady = (output: string) => {
  const plain = getPlainTerminalTail(output)
  return /\bWelcome to Hermes Agent![\s\S]*❯/u.test(plain)
}
const hasGrokPromptReady = (output: string) => /\b(?:Enter:send|Composer\s+\S+)/u.test(output)
const hasPiPromptReady = (output: string) =>
  /\bpi\s+v\d+(?:\.\d+){1,3}[\s\S]*\b(?:escape\s+interrupt|ctrl\+c\/ctrl\+d\s+clear\/exit)\b/iu.test(
    getPlainTerminalTail(output)
  )
const hasAgyPromptReady = (output: string) =>
  /(?:^|\n)\s*>\s*\n\s*(?:[─-]{8,}|\?\s*for shortcuts)/u.test(getPlainTerminalOutput(output))

const getLastNonEmptyTerminalLine = (output: string): string => {
  const normalized = getPlainTerminalOutput(output)
  for (const line of normalized.split('\n').reverse()) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

const hasBarePromptLine = (output: string) => /^[❯›]$/u.test(getLastNonEmptyTerminalLine(output))

const SETUP_PROMPT_PATTERNS = [
  /\bDo you trust\b/iu,
  /\btrust this (?:directory|folder|workspace|project)\b/iu,
  /\bTrust and continue\b/u,
  /\b(?:Log in|Login required|Sign in)\b/iu,
  /\b(?:Enter|Return)\s+to\s+confirm\b/iu,
  /\bEsc\s+to\s+(?:cancel|exit)\b/iu,
  /\b(?:Choose|Pick|Select)\s+(?:a\s+)?(?:theme|option|provider)\b/iu,
]

export const hasFirstRunSetupPrompt = (output: string): boolean => {
  const plainTail = getPlainTerminalTail(output)
  if (hasBarePromptLine(plainTail)) return false

  const recentLines = plainTail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
  const lastLine = recentLines.at(-1) ?? ''
  if (/^[❯›]\s+\d+\.?\s+\S/u.test(lastLine)) return true

  const recent = recentLines.join('\n')
  return SETUP_PROMPT_PATTERNS.some((pattern) => pattern.test(recent))
}

type PromptReadyState = 'not-ready' | 'ready' | 'ready-after-settle'

const getOpencodePromptReadyState = (output: string): PromptReadyState => {
  const recentLines = getRecentNonEmptyTerminalLines(output)
  for (let index = recentLines.length - 1; index >= 0; index--) {
    const line = recentLines[index]
    if (line === undefined) continue
    if (OPENCODE_INTERRUPT_STATUS_PATTERN.test(line)) return 'ready'
    if (OPENCODE_VISIBLE_PROMPT_PATTERN.test(line)) return 'ready'
    if (OPENCODE_COMPLETED_TURN_FOOTER_PATTERN.test(line)) return 'ready-after-settle'
  }
  return 'not-ready'
}

const hasKimiPromptReady = (output: string) => {
  const tail = getPlainTerminalTail(output)
  const prompt = tail.lastIndexOf('│ >')
  const context = tail.lastIndexOf('context:')
  return (
    prompt >= 0 &&
    context > prompt &&
    prompt > tail.lastIndexOf('Preparing Kimi Code') &&
    /│ >\s*│/u.test(tail.slice(prompt, context))
  )
}

const getInteractivePromptReadyState = (output: string, command = ''): PromptReadyState => {
  const commandName = getCommandName(command)
  if (commandName === 'kimi') return hasKimiPromptReady(output) ? 'ready' : 'not-ready'
  if (
    hasBarePromptLine(output) ||
    (commandName === 'agy' && hasAgyPromptReady(output)) ||
    (commandName === 'grok' && hasGrokPromptReady(output)) ||
    (commandName === 'hermes' && hasHermesPromptReady(output)) ||
    (commandName === 'pi' && hasPiPromptReady(output)) ||
    ((commandName === 'gemini' || commandName === 'qwen') && hasGeminiPromptReady(output))
  ) {
    return 'ready'
  }
  if (commandName === 'opencode') {
    return getOpencodePromptReadyState(output)
  }
  return 'not-ready'
}

export const hasInteractivePromptReady = (output: string, command = '') =>
  getInteractivePromptReadyState(output, command) !== 'not-ready'

const outputLength = (run: { output: string; totalOutputLength?: number }) =>
  run.totalOutputLength ?? run.output.length

const outputSince = (output: string, baselineLength: number, totalLength: number) => {
  const length = Math.min(Math.max(0, totalLength - baselineLength), OUTPUT_SCAN_LIMIT)
  return length === 0 ? '' : output.slice(-length)
}

export const hasBracketedPasteAcknowledgement = (
  output: string,
  baselineLength: number,
  totalLength = output.length
) => {
  const outputAfterPaste = outputSince(output, baselineLength, totalLength)
  const pasteEndIndex = outputAfterPaste.lastIndexOf(BRACKETED_PASTE_END)
  const acknowledgementOutput =
    pasteEndIndex === -1
      ? outputAfterPaste
      : outputAfterPaste.slice(pasteEndIndex + BRACKETED_PASTE_END.length)
  return PASTE_ACK_PATTERN.test(acknowledgementOutput)
}

const onlyPasteAcknowledgementWasAppended = (
  baselineLength: number,
  after: { output: string; totalOutputLength?: number }
) => {
  const length = outputLength(after) - baselineLength
  return (
    length > 0 &&
    length <= OUTPUT_SCAN_LIMIT &&
    PASTE_ACK_ONLY_DELTA_PATTERN.test(
      outputSince(after.output, baselineLength, outputLength(after))
    )
  )
}

const shouldWaitForPasteAck = (command: string, text: string) => {
  const commandName = getCommandName(command)
  if (commandName === 'codex') {
    return text.length >= CODEX_PASTE_ACK_MIN_CHARS || HIVE_ACK_GATED_MESSAGE_PATTERN.test(text)
  }
  return COMMANDS_WAITING_FOR_PASTE_ACK.has(commandName)
}
const retriesSubmit = (command: string) => getCommandName(command) === 'codex'
const getPasteAckSettleDelayMs = (command: string) =>
  getCommandName(command) === 'codex' ? CODEX_PASTE_ACK_SETTLE_DELAY_MS : PASTE_ACK_SETTLE_DELAY_MS
const getPasteAckTimeoutMs = (command: string, text: string) => {
  const commandName = getCommandName(command)
  if (commandName === 'codex') return CODEX_PASTE_ACK_TIMEOUT_MS
  if (
    commandName === 'claude' &&
    process.platform === 'win32' &&
    text.length >= CLAUDE_HIVE_PASTE_ACK_MIN_CHARS &&
    HIVE_ACK_GATED_MESSAGE_PATTERN.test(text)
  ) {
    return CLAUDE_HIVE_PASTE_ACK_TIMEOUT_MS
  }
  return PASTE_ACK_TIMEOUT_MS
}
const usesBracketedPaste = (command: string) =>
  COMMANDS_WITH_BRACKETED_PASTE.has(getCommandName(command))
const canTimeoutBeforePromptReady = (command: string) => {
  const commandName = getCommandName(command)
  return (
    commandName !== 'agy' &&
    commandName !== 'gemini' &&
    commandName !== 'hermes' &&
    commandName !== 'kimi' &&
    commandName !== 'opencode' &&
    commandName !== 'pi' &&
    commandName !== 'qwen'
  )
}
const hasPromptReadyHardTimeout = (command: string) => getCommandName(command) !== 'kimi'
const isWritableRunStatus = (status: string | undefined) =>
  status === undefined || status === 'starting' || status === 'running'

const writeIfRunWritable = (agentManager: AgentManager, runId: string, text: string) => {
  let run: ReturnType<AgentManager['getRun']>
  try {
    run = agentManager.getRun(runId)
  } catch {
    return false
  }
  if (!isWritableRunStatus(run.status)) return false
  agentManager.writeInput(runId, text)
  return true
}

const submitPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  command: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean,
  pasteAckSettleDelayMs: number,
  pasteAckTimeoutMs: number,
  retrySubmit: boolean,
  onDone: () => void,
  onError: (error: Error) => void
) => {
  const pastedAt = Date.now()
  const minDelay = getSubmitAfterPasteDelayMs(command, text)
  let acknowledgedAt: number | null = null

  const getWritableOutput = () => {
    try {
      const run = agentManager.getRun(runId)
      return isWritableRunStatus(run.status) ? run : null
    } catch {
      return null
    }
  }
  const getRunOutputState = () => {
    try {
      const run = agentManager.getRun(runId)
      return {
        output: run.output,
        totalOutputLength: outputLength(run),
        writable: isWritableRunStatus(run.status),
      }
    } catch {
      return null
    }
  }

  const submit = (retryAfterSubmit: boolean) => {
    try {
      const outputBeforeSubmit = retryAfterSubmit ? getWritableOutput() : null
      if (!writeIfRunWritable(agentManager, runId, '\r')) {
        onError(createRunInactiveError(runId))
        return
      }
      if (!retryAfterSubmit) {
        onDone()
        return
      }
      setTimeout(() => {
        try {
          const runAfterSubmit = getRunOutputState()
          if (runAfterSubmit === null) {
            onDone()
            return
          }
          if (
            outputBeforeSubmit !== null &&
            hasBracketedPasteAcknowledgement(
              runAfterSubmit.output,
              baselineLength,
              runAfterSubmit.totalOutputLength
            ) &&
            onlyPasteAcknowledgementWasAppended(outputLength(outputBeforeSubmit), runAfterSubmit)
          ) {
            if (!runAfterSubmit.writable || !writeIfRunWritable(agentManager, runId, '\r')) {
              onError(createRunInactiveError(runId))
              return
            }
          }
        } catch (error) {
          onError(toError(error))
          return
        }
        onDone()
      }, CODEX_SUBMIT_RETRY_DELAY_MS)
    } catch (error) {
      // The PTY may have exited between paste and submit.
      onError(toError(error))
    }
  }

  const trySubmit = () => {
    if (!waitForPasteAck) {
      submit(false)
      return
    }

    const output = getWritableOutput()
    if (output === null) {
      onError(createRunInactiveError(runId))
      return
    }
    if (
      acknowledgedAt === null &&
      hasBracketedPasteAcknowledgement(output.output, baselineLength, outputLength(output))
    ) {
      acknowledgedAt = Date.now()
    }

    const elapsed = Date.now() - pastedAt
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= pasteAckSettleDelayMs
    const submitAfterAck = ackSettled && elapsed >= minDelay
    const submitAfterTimeout = elapsed >= pasteAckTimeoutMs
    if (submitAfterAck || submitAfterTimeout) {
      submit(retrySubmit && submitAfterTimeout)
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  setTimeout(trySubmit, minDelay)
}

// Synchronous write for non-interactive commands; an EPIPE/inactive failure
// still throws synchronously (before the promise is returned), preserving the
// dispatcher's contract.
const writeNonInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  text: string
): Promise<void> => {
  if (!writeIfRunWritable(agentManager, runId, `${text}\r`)) {
    throw createRunInactiveError(runId)
  }
  return Promise.resolve()
}

// Shared delivery step for interactive (TUI) commands: snapshot the current
// output as the paste baseline, paste the text (bracketed where supported),
// then run the paste→ack→submit sequence. Used by both the post-start writer
// (after prompt readiness) and the immediate writer (skipping readiness).
const deliverPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  command: string,
  text: string,
  baselineLength: number,
  isInitialAttempt: boolean,
  resolveDone: () => void,
  rejectDone: (error: Error) => void
) => {
  const input = usesBracketedPaste(command)
    ? toBracketedPasteSubmission(text)
    : text.replaceAll('\r', '')
  try {
    if (!writeIfRunWritable(agentManager, runId, input)) {
      rejectDone(createRunInactiveError(runId))
      return
    }
  } catch (error) {
    if (isInitialAttempt) throw error
    rejectDone(toError(error))
    return
  }
  submitPastedInteractiveInput(
    agentManager,
    runId,
    command,
    text,
    baselineLength,
    shouldWaitForPasteAck(command, text),
    getPasteAckSettleDelayMs(command),
    getPasteAckTimeoutMs(command, text),
    retriesSubmit(command),
    resolveDone,
    rejectDone
  )
}

// Immediate writer for already-running members (dispatch path): the member is
// long past its startup window, so skip prompt-readiness polling and the
// first-run setup guard entirely and paste right away. The paste→submit timing
// (bracketed paste, ack wait, codex retry) is preserved so multi-line TUI input
// is still received correctly. Mirrors createPostStartInputWriter's contract:
// an initial-attempt inactive failure throws synchronously.
export const createImmediateInteractiveInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => Promise<void>) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => writeNonInteractiveInput(agentManager, runId, text)
  }

  return (runId, text) =>
    new Promise<void>((resolve, reject) => {
      let baselineLength: number
      try {
        const run = agentManager.getRun(runId)
        if (!isWritableRunStatus(run.status)) {
          reject(createRunInactiveError(runId))
          return
        }
        baselineLength = outputLength(run)
      } catch {
        reject(createRunInactiveError(runId))
        return
      }
      // isInitialAttempt is false here: any throw becomes a rejection rather
      // than a synchronous throw, since delivery happens inside the executor.
      deliverPastedInteractiveInput(
        agentManager,
        runId,
        command,
        text,
        baselineLength,
        false,
        resolve,
        reject
      )
    })
}

// Shared startup policy: observe readiness without injecting a dummy message.
const whenInteractiveInputReady = (
  agentManager: AgentManager,
  runId: string,
  command: string,
  onReady: (baselineLength: number) => void,
  rejectDone: (error: Error) => void
) => {
  const startedAt = Date.now()
  let settleCandidate: { since: number; tail: string } | null = null
  const isReadyToWrite = (output: string) => {
    const promptReadyState = getInteractivePromptReadyState(output, command)
    if (promptReadyState === 'ready') {
      settleCandidate = null
      return true
    }
    if (promptReadyState !== 'ready-after-settle') {
      settleCandidate = null
      return false
    }

    const tail = getPlainTerminalTail(output)
    if (!settleCandidate || settleCandidate.tail !== tail) {
      settleCandidate = { since: Date.now(), tail }
      return false
    }
    return Date.now() - settleCandidate.since >= OPENCODE_COMPLETION_READY_SETTLE_MS
  }
  const tryReady = () => {
    let output: string | null
    let baselineLength = 0
    try {
      const run = agentManager.getRun(runId)
      output = isWritableRunStatus(run.status) ? run.output : null
      baselineLength = outputLength(run)
    } catch {
      rejectDone(createRunInactiveError(runId))
      return
    }
    if (output === null) {
      rejectDone(createRunInactiveError(runId))
      return
    }
    const firstRunSetupPromptVisible = hasFirstRunSetupPrompt(output)
    const now = Date.now()
    const elapsed = now - startedAt
    // Fallback delivery so a readiness anchor that scrolls out of the tail
    // window (e.g. pi's one-shot startup banner) never strands a dispatch.
    // Commands with a soft fallback (codex/claude) deliver after the short
    // READY_TIMEOUT_MS; the other interactive presets use the longer hard
    // timeout, matching the original universal "detect-then-timeout" safety
    // net. The firstRunSetupPrompt guard below still blocks delivery while a
    // genuine trust/login/setup prompt is on screen; such a blocked startup
    // fails at the hard deadline instead of leaving its polling timer alive.
    const fallbackDeliveryDue =
      (canTimeoutBeforePromptReady(command) && elapsed >= READY_TIMEOUT_MS) ||
      (hasPromptReadyHardTimeout(command) && elapsed >= PROMPT_READY_HARD_TIMEOUT_MS)
    if (!firstRunSetupPromptVisible && (isReadyToWrite(output) || fallbackDeliveryDue)) {
      onReady(baselineLength)
      return
    }
    if (elapsed >= PROMPT_READY_HARD_TIMEOUT_MS) {
      rejectDone(new PromptReadinessTimeoutError(command, runId))
      return
    }
    setTimeout(tryReady, READY_CHECK_INTERVAL_MS)
  }
  tryReady()
}

export const waitForPostStartInputReady = (
  agentManager: AgentManager,
  runId: string,
  command: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!isInteractiveAgentCommand(command)) {
      try {
        if (!isWritableRunStatus(agentManager.getRun(runId).status)) {
          reject(createRunInactiveError(runId))
          return
        }
        resolve()
      } catch (error) {
        reject(toError(error))
      }
      return
    }
    whenInteractiveInputReady(agentManager, runId, command, () => resolve(), reject)
  })

export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => Promise<void>) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => writeNonInteractiveInput(agentManager, runId, text)
  }

  return (runId, text) => {
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const rejectableDone = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    let isInitialAttempt = true
    try {
      // Called outside the Promise executor so an initial-attempt throw
      // propagates synchronously to the caller (preserving the dispatcher's
      // synchronous-throw contract) instead of becoming a rejection.
      whenInteractiveInputReady(
        agentManager,
        runId,
        command,
        (baselineLength) => {
          deliverPastedInteractiveInput(
            agentManager,
            runId,
            command,
            text,
            baselineLength,
            isInitialAttempt,
            resolveDone,
            rejectDone
          )
        },
        rejectDone
      )
    } finally {
      isInitialAttempt = false
    }
    return rejectableDone
  }
}
