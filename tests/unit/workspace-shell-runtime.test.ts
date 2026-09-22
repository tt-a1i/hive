import { describe, expect, test } from 'vitest'

import type { AgentManager, StartAgentInput } from '../../src/server/agent-manager.js'
import {
  createWorkspaceShellRuntime,
  resolveWorkspaceShellStart,
} from '../../src/server/workspace-shell-runtime.js'

test('a shell starting during shutdown remains owned if its stop fails', async () => {
  const failure = Object.assign(new Error('stop denied'), { code: 'EPERM' })
  let failStop = true
  let removed = false
  let exited = false
  let onExit: StartAgentInput['onExit']
  const manager = {
    async startAgent(input: StartAgentInput) {
      onExit = input.onExit
      return { runId: 'late-shell', agentId: input.agentId, status: 'running', pid: 42, output: '' }
    },
    stopRun() {
      if (failStop) throw failure
      exited = true
      onExit?.({ runId: 'late-shell', exitCode: 0 })
    },
    removeRun() {
      if (!exited) throw new Error('removed a running shell')
      removed = true
    },
  } as AgentManager
  const runtime = createWorkspaceShellRuntime(manager)
  const starting = runtime.start({ id: 'workspace', name: 'fixture', path: process.cwd() })
  const closing = runtime.close()
  try {
    await expect(starting).rejects.toBe(failure)
    expect(runtime.hasRun('late-shell')).toBe(true)
    expect(removed).toBe(false)
    failStop = false
    expect(runtime.closeRun('workspace', 'late-shell')).toBe(true)
    await closing
    expect(exited).toBe(true)
    expect(removed).toBe(true)
    expect(runtime.hasRun('late-shell')).toBe(false)
  } finally {
    failStop = false
    manager.stopRun('late-shell')
    await closing
    await runtime.close()
  }
})

test.each([
  'close',
  'deleteWorkspace',
] as const)('%s stops other shells when one stop fails and retains the failed shell', async (operation) => {
  const failure = Object.assign(new Error('stop denied'), { code: 'EPERM' })
  let failStop = true
  const runs = new Map<string, { input: StartAgentInput; running: boolean }>()
  const manager = {
    async startAgent(input: StartAgentInput) {
      const runId = `shell-${runs.size}`
      runs.set(runId, { input, running: true })
      return { runId, agentId: input.agentId, status: 'running', pid: 42, output: '' }
    },
    stopRun(runId: string) {
      if (runId === 'shell-0' && failStop) throw failure
      const run = runs.get(runId)
      if (!run) throw new Error('run missing')
      run.running = false
      run.input.onExit?.({ runId, exitCode: 0 })
    },
    removeRun(runId: string) {
      if (runs.get(runId)?.running) throw new Error('removed a running shell')
      runs.delete(runId)
    },
  } as AgentManager
  const runtime = createWorkspaceShellRuntime(manager)
  try {
    const workspace = { id: 'workspace', name: 'fixture', path: process.cwd() }
    await runtime.start(workspace)
    await runtime.start(workspace)
    let observed: unknown
    try {
      if (operation === 'close') await runtime.close()
      else runtime.deleteWorkspace(workspace.id)
    } catch (error) {
      observed = error
    }
    expect(observed).toBeInstanceOf(AggregateError)
    expect((observed as AggregateError).errors).toContain(failure)
    expect(runtime.hasRun('shell-0')).toBe(true)
    expect(runs.get('shell-0')?.running).toBe(true)
    expect(runtime.hasRun('shell-1')).toBe(false)
    expect(runs.has('shell-1')).toBe(false)
    failStop = false
    await runtime.close()
    expect(runtime.hasRun('shell-0')).toBe(false)
    expect(runs.size).toBe(0)
  } finally {
    failStop = false
    await runtime.close()
  }
})

test('failed shell termination preserves the run for explicit retry', async () => {
  const failure = Object.assign(new Error('stop denied'), { code: 'EPERM' })
  let failStop = true
  let removed = false
  let exited = false
  let onExit: StartAgentInput['onExit']
  const run = {
    agentId: 'workspace:shell',
    runId: 'shell-run',
    pid: 42,
    status: 'running' as const,
    output: '',
    exitCode: null,
  }
  // Unit fault model: no mock PTY is used by an integration test.
  const manager = {
    async startAgent(input: StartAgentInput) {
      onExit = input.onExit
      return run
    },
    getRun() {
      if (removed) throw new Error('run missing')
      return run
    },
    stopRun() {
      if (failStop) throw failure
      exited = true
      onExit?.({ runId: run.runId, exitCode: 0 })
    },
    removeRun() {
      removed = true
    },
  } as AgentManager
  const runtime = createWorkspaceShellRuntime(manager)
  try {
    await runtime.start({ id: 'workspace', name: 'fixture', path: process.cwd() })
    expect(() => runtime.closeRun('workspace', run.runId)).toThrow(failure)
    expect(runtime.hasRun(run.runId)).toBe(true)
    expect(runtime.getLiveRun(run.runId)?.status).toBe('running')
    expect(removed).toBe(false)
    failStop = false
    expect(runtime.closeRun('workspace', run.runId)).toBe(true)
    expect(exited).toBe(true)
    expect(removed).toBe(true)
    expect(runtime.hasRun(run.runId)).toBe(false)
  } finally {
    failStop = false
    onExit?.({ runId: run.runId, exitCode: 0 })
    await runtime.close()
  }
})

describe('workspace shell launch resolution', () => {
  test('uses pushd for Windows UNC workspace paths instead of spawning with a UNC cwd', () => {
    const launch = resolveWorkspaceShellStart(
      '\\\\server\\share\\project',
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        SystemRoot: 'C:\\Windows',
      },
      'win32'
    )
    expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(launch.cwd).toBe('C:\\Windows')
    expect(launch.args).toEqual(['/d', '/s', '/k', 'pushd \\\\server\\share\\project'])
  })

  test('keeps normal paths as the shell cwd', () => {
    const launch = resolveWorkspaceShellStart(
      'C:\\Users\\admin\\project',
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      'win32'
    )
    expect(launch.cwd).toBe('C:\\Users\\admin\\project')
    expect(launch.args).toEqual([])
  })
})
