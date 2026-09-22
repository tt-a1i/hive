import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { WORKFLOW_CLI_POLICY_KEY } from '../../src/server/workflow-cli-policy.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import {
  prependPassiveWorkflowCliPath,
  writePassiveWorkflowCli,
} from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const d of dirs.splice(0)) removeTestPath(d)
})
const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-runner-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const waitForValue = async <T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitForValue timeout')
}

// Drive a fake worker by directly invoking the same code path the HTTP
// /api/team/report route uses: store.reportTask. The worker's PTY is real
// (a passive `sleep 60` bash process) — the test does not mock it; it just
// simulates the CLI agent's report submission.
const replyToFirstWorkflowDispatch = async (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  text: string
) => {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 20))
    const submitted = store.listDispatches(workspaceId, { status: 'submitted' })
    const reported = store.listDispatches(workspaceId, { status: 'reported' })
    const target =
      submitted.find((d) => d.workflowRunId !== null) ??
      reported.find((d) => d.workflowRunId !== null)
    if (target) {
      if (target.status === 'submitted') {
        store.reportTask(workspaceId, target.toAgentId, { text, dispatchId: target.id })
      }
      return target
    }
  }
  throw new Error('no workflow dispatch appeared')
}

/* Capture-then-report helper: snapshots the launch config of the first
   workflow-spawned worker before its dispatch reports back, then auto-
   replies so the run completes. Without this the spawn-then-dismiss
   window can be too tight for a polling observer to catch. */
type CapturedLaunch = ReturnType<ReturnType<typeof createRuntimeStore>['peekAgentLaunchConfig']>

const captureLaunchAndReply = (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  text: string
): { captured: Promise<CapturedLaunch>; stop: () => void } => {
  let stopped = false
  let resolveCaptured!: (value: CapturedLaunch) => void
  const captured = new Promise<CapturedLaunch>((res) => {
    resolveCaptured = res
  })
  let alreadyCaptured = false
  void (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 10))
      if (stopped) return
      try {
        const submitted = store
          .listDispatches(workspaceId, { status: 'submitted' })
          .filter((d) => d.workflowRunId !== null)
        for (const d of submitted) {
          if (!alreadyCaptured) {
            alreadyCaptured = true
            const config = store.peekAgentLaunchConfig(workspaceId, d.toAgentId)
            resolveCaptured(config)
          }
          store.reportTask(workspaceId, d.toAgentId, { text, dispatchId: d.id })
        }
      } catch {
        return
      }
    }
  })()
  return {
    captured,
    stop: () => {
      stopped = true
      if (!alreadyCaptured) resolveCaptured(undefined)
    },
  }
}

const writeFakeCodexThatExitsOnDispatchPaste = (binDir: string): string => {
  const scriptPath = join(binDir, 'codex-node.js')
  writeFileSync(
    scriptPath,
    [
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      "const PASTE_END = '\\u001b[201~'",
      "const PASTE_START = '\\u001b[200~'",
      "const WINDOWS_CONPTY_STRIPS_PASTE_BOUNDARIES = process.platform === 'win32'",
      "let pendingInput = ''",
      'let windowsPasteTimer = null',
      "let windowsPastedText = ''",
      "process.stdout.write('› ')",
      'const handlePaste = (pastedText) => {',
      '  const pastedChars = pastedText.length',
      "  if (pastedText.includes('dispatch that exits during paste submit')) {",
      '    setTimeout(() => process.exit(0), 100)',
      '    return',
      '  }',
      "  setTimeout(() => process.stdout.write('\\n[Pasted Content ' + pastedChars + ' chars]\\n'), 50)",
      '}',
      'const handlePlainInput = (text) => {',
      "  if (WINDOWS_CONPTY_STRIPS_PASTE_BOUNDARIES && text !== '\\r' && text !== '\\n' && text !== '\\r\\n') {",
      '    windowsPastedText += text',
      '    if (windowsPasteTimer) clearTimeout(windowsPasteTimer)',
      '    windowsPasteTimer = setTimeout(() => {',
      '      const pastedText = windowsPastedText',
      "      windowsPastedText = ''",
      '      windowsPasteTimer = null',
      '      handlePaste(pastedText)',
      '    }, 50)',
      '    return',
      '  }',
      "  if (text.includes('\\r') || text.includes('\\n')) process.stdout.write('\\nSUBMITTED\\n› ')",
      '}',
      'const drainInput = () => {',
      '  while (pendingInput.length > 0) {',
      '    const start = pendingInput.indexOf(PASTE_START)',
      '    if (start === -1) {',
      '      const plain = pendingInput',
      "      pendingInput = ''",
      '      handlePlainInput(plain)',
      '      return',
      '    }',
      '    if (start > 0) handlePlainInput(pendingInput.slice(0, start))',
      '    const afterStartIndex = start + PASTE_START.length',
      '    const end = pendingInput.indexOf(PASTE_END, afterStartIndex)',
      '    if (end === -1) {',
      '      pendingInput = pendingInput.slice(start)',
      '      return',
      '    }',
      '    const pastedText = pendingInput.slice(afterStartIndex, end)',
      '    pendingInput = pendingInput.slice(end + PASTE_END.length)',
      '    handlePaste(pastedText)',
      '  }',
      '}',
      "process.stdin.on('data', (chunk) => {",
      '  pendingInput += chunk',
      '  drainInput()',
      '})',
      'process.stdin.resume()',
    ].join('\n')
  )
  const unixCli = join(binDir, 'codex')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  const winCli = join(binDir, 'codex.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
  return process.platform === 'win32' ? winCli : unixCli
}

describe('workflow runner — opts.model (TIER 2 #1)', () => {
  test('passes opts.model as `--model <id>` to the spawned worker launch config', async () => {
    /* Regression for TIER 2 #1. Without this, AgentOpts only exposes
       label/agentType/cli/timeoutMs, scripts copied from CC docs with
       `model: 'haiku'` silently no-op, and 100-fan-out audits can't be
       cost-routed to a cheap model. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'with-model.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'with-model', description: 'd' }",
        "await agent('hi', { model: 'haiku-test', label: 'audit' })",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
        expect(run.status).toBe('completed')
        const observed = await captured
        expect(observed?.command).toBe('claude')
        expect(observed?.args).toEqual(['--model', 'haiku-test'])
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  })

  test('omitting opts.model leaves args empty (CLI default model applies)', async () => {
    /* Inverse: confirm we did not add a global '--model X' default that
       would override every CLI's own default. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'no-model.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'no-model', description: 'd' }",
        "await agent('hi', { label: 'plain' })",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
        const observed = await captured
        expect(observed?.args ?? []).toEqual([])
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  })
})

describe('workflow runner — CLI policy (user-selectable agent CLI)', () => {
  test('an agent() that omits cli uses the configured policy default, not hard-coded claude', async () => {
    /* Before the policy, the runner hard-coded `opts.cli ?? 'claude'`, so a
       user who only ran Codex got every default-CLI workflow agent spawning a
       claude it couldn't run. With default='codex' the spawned worker must be
       codex. */
    const { dataDir, workspacePath } = wsPath()
    const binDir = join(dataDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    writePassiveWorkflowCli(binDir, 'codex')
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, 'default-cli.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'default-cli', description: 'd' }",
        "await agent('hi', { label: 'plain' })",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.setAppState(
        WORKFLOW_CLI_POLICY_KEY,
        JSON.stringify({ default: 'codex', allowed: ['claude', 'codex'] })
      )
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
        expect(run.status).toBe('completed')
        const observed = await captured
        expect(observed?.command).toBe('codex')
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  }, 15000)

  test('an explicit Pi workflow worker launches through the supported preset', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['pi'], originalPath)
    const scriptPath = join(workspacePath, 'pi-cli.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'pi-cli', description: 'd' }",
        "return await agent('hi from pi', { cli: 'pi', label: 'pi-worker' })",
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.setAppState(
        WORKFLOW_CLI_POLICY_KEY,
        JSON.stringify({ default: 'claude', allowed: ['claude', 'pi'] })
      )
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
        expect(run.status).toBe('completed')
        const observed = await captured
        expect(observed?.command).toBe('pi')
        expect(observed?.commandPresetId).toBe('pi')
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  }, 15000)

  test('an explicit cli outside the allowlist fails the run with a clear, fixable error', async () => {
    /* The orchestrator authoring the script gets a named, actionable error
       instead of a confusing PTY-start failure, so it can re-author. */
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'bad-cli.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'bad-cli', description: 'd' }",
        "await agent('hi', { cli: 'gemini', label: 'blocked' })",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.setAppState(
        WORKFLOW_CLI_POLICY_KEY,
        JSON.stringify({ default: 'claude', allowed: ['claude', 'codex'] })
      )
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('failed')
      expect(run.error).toMatch(/gemini/)
      expect(run.error).toMatch(/not allowed/i)
      // Rejected before any worker launch — no orphaned ephemeral worker.
      expect(store.listWorkers(ws.id)).toEqual([])
    } finally {
      await store.close()
    }
  })
})

describe('workflow runner — single agent() call', () => {
  test('real workflow worker PTY receives startup before the first dispatch', async () => {
    const { dataDir, workspacePath } = wsPath()
    const binDir = join(dataDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const echoScript = join(binDir, 'claude-echo.js')
    writeFileSync(
      echoScript,
      [
        "process.stdin.setEncoding('utf8')",
        'process.stdin.setRawMode(true)',
        "process.stdout.write('› ')",
        "const PASTE_END = '\\u001b[201~'",
        'let sawPaste = false',
        'let submitReady = false',
        "process.stdin.on('data', (chunk) => {",
        '  process.stdout.write(chunk)',
        "  if (chunk.includes('\\u001b[200~') || chunk.includes('<hive-message')) sawPaste = true",
        "  if (chunk.includes(PASTE_END) || (process.platform === 'win32' && sawPaste && chunk.includes('</hive-message>'))) {",
        "    process.stdout.write('\\n[Pasted text #1]\\n')",
        '    sawPaste = false',
        '    submitReady = true',
        '    return',
        '  }',
        '  if (submitReady && /^[\\r\\n]+$/.test(chunk)) {',
        "    process.stdout.write('\\nSUBMITTED\\n› ')",
        '    submitReady = false',
        '  }',
        '})',
        'process.stdin.resume()',
        'setInterval(() => {}, 1 << 30)',
      ].join('\n')
    )
    const unixCli = join(binDir, 'claude')
    writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${echoScript}" "$@"\n`)
    chmodSync(unixCli, 0o755)
    writeFileSync(
      join(binDir, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "${echoScript}" %*\r\n`
    )
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const scriptPath = join(workspacePath, 'startup-before-dispatch.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'startup-before-dispatch', description: 'd' }",
        "return await agent('ordered dispatch', { label: 'ordered-worker' })",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.startWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      const dispatch = await waitForValue(
        () =>
          store
            .listDispatches(ws.id, { status: 'submitted' })
            .find((item) => item.workflowRunId === run.id),
        12_000
      )
      const output = await waitForValue(() => {
        const text = store.getActiveRunByAgentId(ws.id, dispatch.toAgentId)?.output
        return text?.includes('ordered dispatch') ? text.replace(/\r\n/g, '\n') : undefined
      }, 12_000)
      const startupIndex = output.indexOf('<hive-message kind="startup">')
      const dispatchIndex = output.indexOf('<hive-message kind="dispatch"')
      expect(startupIndex).toBeGreaterThanOrEqual(0)
      expect(dispatchIndex).toBeGreaterThan(startupIndex)
      expect(output).toContain('one-shot Hive workflow member')
      expect(store.stopWorkflowRun(run.id)).toBe(true)
      await waitForValue(() =>
        store.getWorkflowRun(run.id)?.status === 'stopped' ? true : undefined
      )
    } finally {
      await store.close()
    }
  }, 20_000)

  test('spawns ephemeral worker, awaits report, completes the run, dismisses the worker', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'echo.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'echo', description: 'one agent call' }",
        "const result = await agent('say hello')",
        'return result',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')

      const replier = replyToFirstWorkflowDispatch(store, ws.id, 'hello back')

      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      await replier

      expect(run.status).toBe('completed')
      expect(run.error).toBeNull()
      // Ephemeral worker was dismissed after the call.
      expect(store.listWorkers(ws.id).length).toBe(0)
    } finally {
      await store.close()
    }
  })

  test('agent({ outputSchema }) resolves to the parsed json block from the report', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'schema.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'schema', description: 'structured output' }",
        "return await agent('judge it', { outputSchema: { refuted: 'boolean' } })",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const replier = replyToFirstWorkflowDispatch(
        store,
        ws.id,
        'looks solid\n\n```json\n{"refuted": false}\n```'
      )
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      await replier

      expect(run.status).toBe('completed')
      expect(run.result).toEqual({ refuted: false })
    } finally {
      await store.close()
    }
  })

  test('agent({ outputSchema }) falls back to { text } when the report has no json block', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'schema-miss.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'schema-miss', description: 'parse miss' }",
        "return await agent('judge it', { outputSchema: { refuted: 'boolean' } })",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const replier = replyToFirstWorkflowDispatch(store, ws.id, 'just prose, no block')
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      await replier

      expect(run.status).toBe('completed')
      expect(run.result).toEqual({ text: 'just prose, no block' })
    } finally {
      await store.close()
    }
  })

  test('fails the run when a script error is thrown', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'boom.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'boom', description: 'throws' }",
        "throw new Error('intentional')",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('failed')
      expect(run.error).toMatch(/intentional/)
      expect(store.listWorkers(ws.id).length).toBe(0)
    } finally {
      await store.close()
    }
  })

  test('phase() updates the workflow_runs row', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'phases.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'phases', description: 'phase updates' }",
        "phase('Find')",
        'return 1',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('completed')
      expect(run.phase).toBe('Find')
    } finally {
      await store.close()
    }
  })

  test('sandbox blocks computed-constructor escape from a workflow script', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'constructor-escape.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'constructor-escape', description: 'd' }",
        "return agent['constructor']('return process')().getBuiltinModule('node:fs').existsSync('package.json')",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('failed')
      expect(run.error).toMatch(/code generation|disallowed|process|constructor/i)
      expect(store.listWorkers(ws.id)).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  test('sandbox blocks unicode-escaped process identifiers that static token scanning misses', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'unicode-process.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'unicode-process', description: 'd' }",
        'return pro\\u0063ess.version',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('failed')
      expect(run.error).toMatch(/process is not defined|process/i)
    } finally {
      await store.close()
    }
  })

  test('sandbox still allows normal pure-JS shaping such as Object.entries(args)', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'object-entries.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'object-entries', description: 'd' }",
        'return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]))',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
        args: { count: 3, label: 'ok' },
      })
      expect(run.status).toBe('completed')
      expect(run.result).toEqual({ count: '3', label: 'ok' })
    } finally {
      await store.close()
    }
  })

  test('cancels a workflow dispatch promptly when the worker exits during Codex paste-submit', async () => {
    const { dataDir, workspacePath } = wsPath()
    const binDir = join(dataDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakeCodexCommand = writeFakeCodexThatExitsOnDispatchPaste(binDir)
    const scriptPath = join(workspacePath, 'codex-exit.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'codex-exit', description: 'worker exits during dispatch' }",
        "await agent('dispatch that exits during paste submit', { agentType: 'codex-exit-template', label: 'codex-fail', timeoutMs: 20000 })",
        'return 1',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.createRoleTemplate({
        name: 'codex-exit-template',
        roleType: 'custom',
        description: 'fake Codex that exits after receiving a workflow dispatch paste',
        defaultCommand: fakeCodexCommand,
        defaultArgs: [],
        defaultEnv: {},
      })
      const startedAt = Date.now()
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })

      expect(Date.now() - startedAt).toBeLessThan(10000)
      expect(run.status).toBe('failed')
      expect(store.listWorkflowRunDispatches(run.id)).toContainEqual(
        expect.objectContaining({
          status: 'cancelled',
          text: 'dispatch that exits during paste submit',
        })
      )
      expect(store.listWorkers(ws.id)).toEqual([])
    } finally {
      await store.close()
    }
  }, 30000)
})
