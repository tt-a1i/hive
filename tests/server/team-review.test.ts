import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { TEAM_REVIEW_TASK_PREFIX } from '../../src/shared/types.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

interface HiveContext {
  baseUrl: string
  dataDir: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  orchestratorId: string
  presets: Record<string, { command: string; id: string }>
  worker: { id: string; name: string }
  workspaceId: string
}

const createPreset = (
  store: HiveContext['hive']['store'],
  name: string,
  extras: { args?: string[]; command?: string } = {}
): { command: string; id: string } =>
  store.settings.createCommandPreset({
    args: extras.args ?? [],
    command: extras.command ?? name,
    displayName: name,
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })

const setOrchVendor = (ctx: HiveContext, command: string, args: string[] = []) => {
  const current = ctx.hive.store.peekAgentLaunchConfig(ctx.workspaceId, ctx.orchestratorId)
  ctx.hive.store.configureAgentLaunch(ctx.workspaceId, ctx.orchestratorId, {
    args,
    command,
    commandPresetId: current?.commandPresetId ?? null,
    cwd: current?.cwd ?? null,
    interactiveCommand: current?.interactiveCommand ?? null,
    ...(current?.presetAugmentationDisabled !== undefined
      ? { presetAugmentationDisabled: current.presetAugmentationDisabled }
      : {}),
    resumeArgsTemplate: current?.resumeArgsTemplate ?? null,
    sessionIdCapture: current?.sessionIdCapture ?? null,
  })
}

const setupHive = async (cliNames: readonly string[]): Promise<HiveContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-review-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerResponse.json()) as { id: string; name: string }

  for (const agentId of [orchestratorId, worker.id]) {
    await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        command: process.execPath,
        args: [passiveScript],
      }),
    })
    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      }
    )
    expect(startResponse.status).toBe(201)
  }

  // Keep platform shell tools, but exclude the user's installed agent CLIs.
  let shellPath = ['/usr/bin', '/bin'].join(delimiter)
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('Windows test fixture requires SystemRoot')
    shellPath = join(systemRoot, 'System32')
  }
  prependPassiveWorkflowCliPath(dataDir, cliNames, shellPath)
  const presets = Object.fromEntries(cliNames.map((name) => [name, createPreset(hive.store, name)]))
  return { baseUrl, dataDir, hive, orchestratorId, presets, worker, workspaceId: workspace.id }
}

const reviewBody = (
  ctx: HiveContext,
  extra: Record<string, unknown> = {},
  from: { id: string; token: string | undefined } = {
    id: ctx.orchestratorId,
    token: ctx.hive.store.peekAgentToken(ctx.orchestratorId),
  }
) => ({
  workspace_id: ctx.workspaceId,
  from_agent_id: from.id,
  token: from.token,
  ...extra,
})

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('POST /api/team/review', () => {
  test('creates an ephemeral member with the requested role and cli and one orch dispatch', async () => {
    const ctx = await setupHive(['node', 'bash'])
    try {
      const nodePreset = ctx.presets.node
      if (!nodePreset) throw new Error('expected node preset')
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          reviewBody(ctx, {
            cli: nodePreset.id,
            focus: 'auth retry',
            name: 'inspector',
            role: 'tester',
          })
        ),
      })
      expect(response.status).toBe(201)
      const created = (await response.json()) as {
        cli: string
        dispatch_id: string
        member_name: string
        role: string
      }
      expect(created.cli).toBe(nodePreset.id)
      expect(created.member_name).toBe('inspector')
      expect(created.role).toBe('tester')

      const member = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .find((item) => item.name === 'inspector')
      if (!member) throw new Error('expected inspector member')
      expect(member.role).toBe('tester')
      expect(member.ephemeral).toBe(true)
      expect(member.spawnedBy).toBe('orchestrator')
      expect(ctx.hive.store.peekAgentLaunchConfig(ctx.workspaceId, member.id)?.command).toBe('node')

      const open = ctx.hive.store.listOpenDispatches(ctx.workspaceId)
      expect(open).toHaveLength(1)
      const ledgerDispatch = open[0]
      if (!ledgerDispatch) throw new Error('expected open review dispatch')
      expect(created.dispatch_id).toBe(ledgerDispatch.id)
      expect(ledgerDispatch.fromAgentId).toBe(ctx.orchestratorId)
      expect(ledgerDispatch.toAgentId).toBe(member.id)
      expect(ledgerDispatch.text.startsWith(TEAM_REVIEW_TASK_PREFIX)).toBe(true)
      expect(ledgerDispatch.text).toContain('Focus: auth retry')
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('rejects a worker token with 403', async () => {
    const ctx = await setupHive(['node'])
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) throw new Error('Expected worker token after start')
      const before = ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          reviewBody(ctx, { focus: 'should not run' }, { id: ctx.worker.id, token: workerToken })
        ),
      })
      expect(response.status).toBe(403)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)).toEqual(before)
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('omitted cli picks a known different CLI family than the orchestrator', async () => {
    const ctx = await setupHive(['codex', 'gemini'])
    try {
      setOrchVendor(ctx, 'codex')
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { focus: 'uncommitted diff' })),
      })
      expect(response.status).toBe(201)
      const created = (await response.json()) as { cli: string; member_name: string }
      // Built-in presets precede custom presets with the same executable.
      expect(created.cli).toBe('gemini')

      const member = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .find((item) => item.name === created.member_name)
      if (!member) throw new Error('expected review member')
      const memberCommand = ctx.hive.store.peekAgentLaunchConfig(
        ctx.workspaceId,
        member.id
      )?.command
      expect(memberCommand).toBe('gemini')
      expect(memberCommand).not.toBe('codex')
      expect(member.role).toBe('reviewer')
      expect(member.ephemeral).toBe(true)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('omitted cli rejects an unknown shell without creating a review member or dispatch', async () => {
    const ctx = await setupHive(['codex', 'bash'])
    try {
      setOrchVendor(ctx, 'codex')
      const before = ctx.hive.store.listWorkers(ctx.workspaceId).map((member) => member.id)
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { focus: 'uncommitted diff' })),
      })
      expect(response.status).toBe(409)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).map((member) => member.id)).toEqual(before)
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('omitted cli errors 409 when only the orchestrator command is available', async () => {
    const ctx = await setupHive(['claude'])
    try {
      setOrchVendor(ctx, 'claude')
      const nodePreset = ctx.presets.claude
      if (!nodePreset) throw new Error('expected claude preset')
      const workersBefore = ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)
      const openBefore = ctx.hive.store.listOpenDispatches(ctx.workspaceId)
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { focus: 'same vendor' })),
      })
      expect(response.status).toBe(409)
      expect(
        ctx.hive.store.listWorkers(ctx.workspaceId).some((item) => item.ephemeral === true)
      ).toBe(false)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)).toEqual(
        workersBefore
      )
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual(openBefore)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('reporting the review dispatch dismisses the member and keeps the report in the log', async () => {
    const ctx = await setupHive(['node'])
    try {
      const nodePreset = ctx.presets.node
      if (!nodePreset) throw new Error('expected node preset')
      const createdResponse = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          reviewBody(ctx, { cli: nodePreset.id, focus: 'login form', name: 'one-shot-review' })
        ),
      })
      expect(createdResponse.status).toBe(201)
      const created = (await createdResponse.json()) as {
        dispatch_id: string
        member_name: string
      }
      const member = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .find((item) => item.name === created.member_name)
      if (!member) throw new Error('expected review member')
      const memberToken = ctx.hive.store.peekAgentToken(member.id)
      if (!memberToken) throw new Error('expected review member token after auto-start')

      ctx.hive.store.statusTask(ctx.workspaceId, member.id, {
        text: 'status-should-be-purged',
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .some((item) => item.type === 'status' && item.text.includes('status-should-be-purged'))
      ).toBe(true)

      const reportResponse = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: member.id,
          token: memberToken,
          dispatch_id: created.dispatch_id,
          result: 'no blocking findings in login form',
        }),
      })
      expect(reportResponse.status).toBe(202)

      await waitFor(() => {
        expect(
          ctx.hive.store
            .listWorkers(ctx.workspaceId)
            .some((item) => item.name === created.member_name)
        ).toBe(false)
      })

      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(
        messages.some(
          (item) =>
            item.type === 'send' && item.to === member.id && item.text.includes('Focus: login form')
        )
      ).toBe(true)
      expect(
        messages.some(
          (item) =>
            item.type === 'report' && item.text.includes('no blocking findings in login form')
        )
      ).toBe(true)
      expect(messages.some((item) => item.type === 'status')).toBe(false)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('cancelling the review dispatch dismisses the member and keeps the send log', async () => {
    const ctx = await setupHive(['node'])
    try {
      const nodePreset = ctx.presets.node
      if (!nodePreset) throw new Error('expected node preset')
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('expected orchestrator token after start')

      const createdResponse = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          reviewBody(ctx, { cli: nodePreset.id, focus: 'auth retry', name: 'cancel-review' })
        ),
      })
      expect(createdResponse.status).toBe(201)
      const created = (await createdResponse.json()) as {
        dispatch_id: string
        member_name: string
      }
      const member = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .find((item) => item.name === created.member_name)
      if (!member) throw new Error('expected review member')
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId).map((item) => item.id)).toEqual([
        created.dispatch_id,
      ])

      const cancelResponse = await fetch(`${ctx.baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          dispatch_id: created.dispatch_id,
          reason: 'review no longer needed',
        }),
      })
      expect(cancelResponse.status).toBe(202)

      await waitFor(() => {
        expect(
          ctx.hive.store
            .listWorkers(ctx.workspaceId)
            .some((item) => item.id === member.id || item.name === created.member_name)
        ).toBe(false)
      })

      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual([])
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(
        messages.some(
          (item) =>
            item.type === 'send' && item.to === member.id && item.text.includes('Focus: auth retry')
        )
      ).toBe(true)
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('omitted cli auto-picks a different npx package and rejects the same package', async () => {
    const ctx = await setupHive([])
    prependPassiveWorkflowCliPath(ctx.dataDir, ['npx'], process.env.PATH)
    try {
      const claudePkg = createPreset(ctx.hive.store, 'npx-claude', {
        args: ['@anthropic-ai/claude-code'],
        command: 'npx',
      })
      const codexPkg = createPreset(ctx.hive.store, 'npx-codex', {
        args: ['@openai/codex'],
        command: 'npx',
      })
      setOrchVendor(ctx, 'npx', ['@anthropic-ai/claude-code'])

      const picked = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { focus: 'cross vendor npx' })),
      })
      expect(picked.status).toBe(201)
      const created = (await picked.json()) as { cli: string; member_name: string }
      expect(created.cli).toBe(codexPkg.id)
      expect(created.cli).not.toBe(claudePkg.id)
      const member = ctx.hive.store
        .listWorkers(ctx.workspaceId)
        .find((item) => item.name === created.member_name)
      if (!member) throw new Error('expected review member')
      expect(ctx.hive.store.peekAgentLaunchConfig(ctx.workspaceId, member.id)?.args).toEqual([
        '@openai/codex',
      ])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('omitted cli 409s when every npx preset is the same package as the orchestrator', async () => {
    const ctx = await setupHive([])
    prependPassiveWorkflowCliPath(ctx.dataDir, ['npx'], process.env.PATH)
    try {
      createPreset(ctx.hive.store, 'npx-claude', {
        args: ['--yes', '@anthropic-ai/claude-code@latest'],
        command: 'npx',
      })
      setOrchVendor(ctx, 'npx', ['@anthropic-ai/claude-code'])
      const workersBefore = ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { focus: 'same npx package' })),
      })
      expect(response.status).toBe(409)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)).toEqual(
        workersBefore
      )
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('reviewer PTY that fails to start rolls back the ephemeral member and leaves no pending dispatch', async () => {
    const ctx = await setupHive(['node'])
    try {
      const deadPath = join(ctx.dataDir, 'bin', 'dead-review-cli')
      writeFileSync(deadPath, '#!/bin/sh\nexit 1\n')
      chmodSync(deadPath, 0o755)
      const dead = createPreset(ctx.hive.store, 'dead-review-cli', {
        command: 'dead-review-cli',
      })
      const workersBefore = ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)
      const response = await fetch(`${ctx.baseUrl}/api/team/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reviewBody(ctx, { cli: dead.id, focus: 'should roll back' })),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(
        ctx.hive.store.listWorkers(ctx.workspaceId).some((item) => item.ephemeral === true)
      ).toBe(false)
      expect(ctx.hive.store.listWorkers(ctx.workspaceId).map((item) => item.id)).toEqual(
        workersBefore
      )
      expect(ctx.hive.store.listOpenDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)
})
