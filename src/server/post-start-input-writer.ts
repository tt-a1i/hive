import { basename } from 'node:path'

import type { AgentManager } from './agent-manager.js'

const INTERACTIVE_COMMANDS = new Set(['claude', 'codex', 'gemini', 'opencode'])
const READY_CHECK_INTERVAL_MS = 50
const READY_TIMEOUT_MS = 3000

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~\r`

export const isInteractiveAgentCommand = (command: string) =>
  INTERACTIVE_COMMANDS.has(basename(command).toLowerCase())

export const hasInteractivePromptReady = (output: string) => /(?:^|[\r\n])\s*[❯›]\s*/u.test(output)

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
        agentManager.writeInput(runId, toBracketedPasteSubmission(text))
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    tryWrite()
  }
}
