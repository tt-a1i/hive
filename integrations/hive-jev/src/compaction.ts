import { IntegrationError } from './errors.js'
import { callJev, type JevAnswer } from './typesafe.js'

interface ToolUse {
  tool_use_id: string
  tool: string
  input: unknown
}

interface ToolResult {
  tool_use_id: string
  text: string
  is_error?: boolean | undefined
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  tool_uses?: ToolUse[] | undefined
  tool_results?: ToolResult[] | undefined
}

interface CompactionOptions {
  preserve_recent_messages?: number | undefined
  keep_threshold?: number | undefined
  goal?: string | undefined
}

function answerScore(answer: JevAnswer | undefined): number {
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul)) {
    throw new IntegrationError(
      'typesafe_invalid_compaction_answer',
      'TypeSafe returned an invalid compaction answer; the source history was preserved.'
    )
  }
  if (answer.noul < 0 || answer.noul > 1) {
    throw new IntegrationError(
      'typesafe_invalid_compaction_answer',
      'TypeSafe returned an out-of-range compaction answer; the source history was preserved.'
    )
  }
  return answer.noul
}

export async function compactMessages(
  messages: TranscriptMessage[],
  options: CompactionOptions = {}
) {
  const recent = Math.max(0, Math.floor(options.preserve_recent_messages ?? 6))
  const threshold = options.keep_threshold ?? 0.5
  const protectedFrom = Math.max(0, messages.length - recent)
  const candidates: Array<{ messageIndex: number; toolUse: ToolUse }> = []
  for (let messageIndex = 0; messageIndex < protectedFrom; messageIndex += 1) {
    const message = messages[messageIndex]
    if (!message) continue
    for (const toolUse of message.tool_uses ?? []) {
      candidates.push({ messageIndex, toolUse })
    }
  }
  if (candidates.length === 0) {
    return { source_history_mutated: false, messages: structuredClone(messages), decisions: [] }
  }

  const questions: Record<string, unknown> = {}
  for (const { toolUse } of candidates) {
    questions[`call_${toolUse.tool_use_id}`] = {
      type: 'noul',
      instructions: `Keep tool call ${toolUse.tool_use_id} (${toolUse.tool}) because it still matters for the stated goal.`,
    }
    questions[`result_${toolUse.tool_use_id}`] = {
      type: 'noul',
      instructions: `Keep the full result of tool call ${toolUse.tool_use_id} (${toolUse.tool}) because its verbatim contents are still needed.`,
    }
  }
  const state = {
    goal: options.goal ?? '',
    history: messages.map((message) => ({
      role: message.role,
      text: message.text,
      tools: (message.tool_uses ?? []).map(({ tool_use_id, tool, input }) => ({
        tool_use_id,
        tool,
        input,
      })),
      tool_results: (message.tool_results ?? []).map(({ tool_use_id, text, is_error }) => ({
        tool_use_id,
        text,
        ...(is_error === undefined ? {} : { is_error }),
      })),
    })),
  }
  const result = await callJev(state, questions)
  const decisions = candidates.map(({ toolUse }) => {
    const keepCall = answerScore(result.answers[`call_${toolUse.tool_use_id}`])
    const keepResult = answerScore(result.answers[`result_${toolUse.tool_use_id}`])
    const action =
      keepResult >= threshold ? 'keep' : keepCall >= threshold ? 'drop_result' : 'drop_call'
    return {
      tool_use_id: toolUse.tool_use_id,
      tool: toolUse.tool,
      action,
      keep_call: keepCall,
      keep_result: keepResult,
    }
  })
  const actions = new Map(decisions.map((decision) => [decision.tool_use_id, decision.action]))
  const compacted = messages.flatMap((message) => {
    const copy = structuredClone(message)
    copy.tool_uses = (copy.tool_uses ?? []).filter(
      (tool) => actions.get(tool.tool_use_id) !== 'drop_call'
    )
    copy.tool_results = (copy.tool_results ?? []).flatMap((toolResult) => {
      const action = actions.get(toolResult.tool_use_id)
      if (action === 'drop_call') return []
      if (action === 'drop_result') {
        return [
          {
            ...toolResult,
            text: '[Jev compaction removed this stale tool result; rerun the tool if needed.]',
          },
        ]
      }
      return [toolResult]
    })
    return copy.text || (copy.tool_uses?.length ?? 0) || (copy.tool_results?.length ?? 0)
      ? [copy]
      : []
  })
  return { source_history_mutated: false, messages: compacted, decisions }
}
