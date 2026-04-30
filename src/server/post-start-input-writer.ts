import { basename } from 'node:path'

import type { AgentManager } from './agent-manager.js'

const INTERACTIVE_COMMANDS = new Set(['claude', 'codex', 'gemini', 'opencode'])
const READY_CHECK_INTERVAL_MS = 50
const READY_TIMEOUT_MS = 3000
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 100
const PASTE_ACK_TIMEOUT_MS = 3000

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~`

const getSubmitAfterPasteDelayMs = (text: string) =>
  Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )

export const isInteractiveAgentCommand = (command: string) =>
  INTERACTIVE_COMMANDS.has(basename(command).toLowerCase())

export const hasInteractivePromptReady = (output: string) => /(?:^|[\r\n])\s*[❯›]\s*/u.test(output)

export const hasBracketedPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[Pasted text #\d+/u.test(output.slice(baselineLength))

const isClaudeCommand = (command: string) => basename(command).toLowerCase() === 'claude'

const submitPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean
) => {
  const pastedAt = Date.now()
  const minDelay = getSubmitAfterPasteDelayMs(text)
  let acknowledgedAt: number | null = null

  const submit = () => {
    try {
      agentManager.writeInput(runId, '\r')
    } catch {
      // The PTY may have exited between paste and submit.
    }
  }

  const trySubmit = () => {
    if (!waitForPasteAck) {
      submit()
      return
    }

    try {
      const output = agentManager.getRun(runId).output
      if (acknowledgedAt === null && hasBracketedPasteAcknowledgement(output, baselineLength)) {
        acknowledgedAt = Date.now()
      }
    } catch {
      return
    }

    const elapsed = Date.now() - pastedAt
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
    if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
      submit()
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  setTimeout(trySubmit, minDelay)
}

export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => void) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => agentManager.writeInput(runId, `${text}\n`)
  }

  return (runId, text) => {
    const startedAt = Date.now()
    const tryWrite = () => {
      let output: string
      try {
        output = agentManager.getRun(runId).output
      } catch {
        return
      }
      if (hasInteractivePromptReady(output) || Date.now() - startedAt >= READY_TIMEOUT_MS) {
        const baselineLength = output.length
        agentManager.writeInput(runId, toBracketedPasteSubmission(text))
        submitPastedInteractiveInput(
          agentManager,
          runId,
          text,
          baselineLength,
          isClaudeCommand(command)
        )
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    tryWrite()
  }
}
