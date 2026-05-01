import { describe, expect, test } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'

const codexPreset: CommandPresetRecord = {
  args: [],
  command: 'codex',
  displayName: 'Codex',
  env: {},
  id: 'codex',
  isBuiltin: true,
  resumeArgsTemplate: 'resume {session_id}',
  sessionIdCapture: {
    pattern: '~/.codex/sessions/**/*.jsonl',
    source: 'codex_session_jsonl_dir',
  },
  yoloArgsTemplate: null,
}

const createSessionStore = (sessionId: string): AgentSessionStore => ({
  clearLastSessionId: () => {},
  getLastSessionId: () => sessionId,
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('does not snapshot sessions before spawning when a preset resume id is available', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      createSessionStore(sessionId),
      (id) => (id === 'codex' ? codexPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    expect(bootstrap.sessionCaptureSnapshot).toBeUndefined()
  })
})
