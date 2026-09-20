import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { INTEGRATION_NAME, INTEGRATION_VERSION } from './constants.js'
import { compactMessages, reviewAction, routeTask, runBrowserTask, status } from './core.js'
import { IntegrationError } from './errors.js'

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
const executing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}
const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})
const guarded =
  <T>(handler: (args: T) => unknown | Promise<unknown>) =>
  async (args: T) => {
    try {
      return ok(await handler(args))
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ code: error.code, message: error.message }),
          },
        ],
      }
    }
  }

export function createServer() {
  const server = new McpServer(
    { name: INTEGRATION_NAME, version: INTEGRATION_VERSION },
    {
      instructions:
        'Optional decision layer for Hive. Routing never dispatches or changes members. Compaction only changes a supplied copy. Automatic approval is limited to clear low-risk actions. Browser execution requires explicit opt-in and an independent expected outcome.',
    }
  )
  server.registerTool(
    'hive_jev_status',
    {
      description: 'Show redacted integration status.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    guarded(status)
  )
  server.registerTool(
    'hive_jev_route_task',
    {
      description:
        'Recommend one existing Hive member and effort without dispatching or changing model configuration.',
      inputSchema: z.object({
        task: z.string().min(1).max(40_000),
        context: z.string().max(20_000).optional(),
        roster_source: z.literal('hive_authoritative_snapshot'),
        candidates: z
          .array(
            z.object({ id: z.string().min(1).max(100), description: z.string().min(1).max(2_000) })
          )
          .min(1)
          .max(20),
      }),
      annotations: readOnly,
    },
    guarded(routeTask)
  )
  server.registerTool(
    'hive_jev_compact_messages',
    {
      description:
        'Compact a transcript copy while preserving original user/assistant text and the source history.',
      inputSchema: z.object({
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              text: z.string(),
              tool_uses: z
                .array(z.object({ tool_use_id: z.string(), tool: z.string(), input: z.unknown() }))
                .optional(),
              tool_results: z
                .array(
                  z.object({
                    tool_use_id: z.string(),
                    text: z.string(),
                    is_error: z.boolean().optional(),
                  })
                )
                .optional(),
            })
          )
          .min(1)
          .max(500),
        goal: z.string().max(10_000).optional(),
        keep_threshold: z.number().min(0).max(1).optional(),
        preserve_recent_messages: z.number().int().min(0).max(100).optional(),
      }),
      annotations: readOnly,
    },
    guarded(({ messages, ...options }) => compactMessages(messages, options))
  )
  server.registerTool(
    'hive_jev_review_action',
    {
      description:
        'Review one exact pending action and auto-approve only clear low-risk actions. Does not execute host tools.',
      inputSchema: z.object({
        user_request: z.string().min(1).max(40_000),
        trusted_context: z.string().max(20_000).optional(),
        untrusted_evidence: z.string().max(20_000).optional(),
        allow_auto_approval: z.boolean().optional(),
        auto_approve_tools: z.array(z.string().min(1).max(200)).max(50).optional(),
        action: z.object({ tool: z.string().min(1).max(200), arguments: z.unknown() }),
      }),
      annotations: readOnly,
    },
    guarded(reviewAction)
  )
  server.registerTool(
    'hive_jev_browser_run',
    {
      description:
        'Use Jev to operate an owned browser tab through observed CDP targets. DeepSeek writes field text. Stops before sensitive actions.',
      inputSchema: z.object({
        url: z.url(),
        goal: z.string().min(1).max(20_000),
        allow_execution: z.literal(true),
        allowed_origins: z.array(z.url()).max(20).optional(),
        expect_url_contains: z.string().max(2_000).optional(),
        expect_title_contains: z.string().max(2_000).optional(),
        expect_text_contains: z.string().max(2_000).optional(),
        max_actions: z.number().int().min(1).max(12).optional(),
      }),
      annotations: executing,
    },
    guarded(runBrowserTask)
  )
  return server
}
