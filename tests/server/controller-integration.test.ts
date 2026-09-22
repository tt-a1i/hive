import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { callHiveMcpTool } from '../../src/cli/hive-mcp.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Exercise the shipped stdio parser, including its host-metadata boundary.
const requestConnection = (baseUrl: string, workspaceId: string, threadId: string) =>
  new Promise<Array<{ id: number; error?: unknown }>>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/hive.ts', 'mcp', '--controller', '--base-url', baseUrl],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(errors))
      try {
        resolveResult(
          output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )
      } catch (error) {
        reject(error)
      }
    })
    const calls = [
      { arguments: { workspace_id: workspaceId } },
      {
        _meta: { threadId, 'x-codex-turn-metadata': { thread_id: randomUUID() } },
        arguments: { workspace_id: workspaceId },
      },
      { _meta: { threadId }, arguments: { workspace_id: workspaceId, thread_id: randomUUID() } },
      { _meta: { threadId }, arguments: { workspace_id: workspaceId } },
    ]
    for (const [index, params] of calls.entries())
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'hive.controller_connect', ...params } })}\n`
      )
    child.stdin.end()
  })

// First-phase controller support is local macOS. Linux also exercises the POSIX
// process contract in CI. Codex itself is covered by the recorded real App probe.
describe.skipIf(process.platform === 'win32')(
  'external controller real HTTP / SQLite / PTY',
  () => {
    let server: Awaited<ReturnType<typeof startTestServer>> | undefined
    let root: string | undefined
    afterEach(async () => {
      await server?.close()
      server = undefined
      vi.unstubAllEnvs()
      if (root) removeTestPath(root)
    })

    test('persists a real member report, rejects wrong callers and replays operations across restart', async () => {
      root = mkdtempSync(join(tmpdir(), 'hive-controller-'))
      const bin = join(root, 'bin')
      mkdirSync(bin)
      // This executable only supplies notification capability/failure. Member PTY,
      // protocol, HTTP, SQLite and recovery all use their actual implementations.
      const codex = join(bin, 'codex')
      writeFileSync(codex, '#!/bin/sh\nif [ "$2" = "--help" ]; then exit 0; fi\nexit 1\n', {
        mode: 0o755,
      })
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
      const dataDir = join(root, 'data')
      server = await startTestServer({ dataDir })
      let cookie = await getUiCookie(server.baseUrl)
      const ui = async (path: string, body?: unknown) => {
        const response = await fetch(`${server?.baseUrl}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: response.status, data: await response.json() }
      }
      const threadId = randomUUID()
      const created = await ui('/api/workspaces', {
        name: 'Controller integration',
        path: root,
        controller_mode: 'codex_app',
      })
      expect(created.status).toBe(201)
      const workspaceId = created.data.id as string
      const statusPath = `/api/workspaces/${workspaceId}/controller`
      const mcp = (name: string, args: Record<string, unknown>, identity = threadId) => {
        if (!server) throw new Error('Controller test server is not running')
        return callHiveMcpTool(name, args, {
          baseUrl: server.baseUrl,
          metadata: { threadId: identity },
        })
      }
      const action = (name: string, args: Record<string, unknown> = {}, identity = threadId) =>
        mcp(
          'hive.controller_action',
          { workspace_id: workspaceId, action: name, ...args },
          identity
        )
      await expect(action('inspect')).rejects.toThrow()
      const connections = await requestConnection(server.baseUrl, workspaceId, threadId)
      expect(connections.map((result) => Boolean(result.error))).toEqual([true, true, true, false])
      const uiStatus = (await ui(statusPath)).data
      expect(uiStatus.runtime_port).toBe(Number(new URL(server.baseUrl).port))
      const pending = uiStatus.pending_request
      expect(pending.thread_id).toBe(threadId)
      const confirmed = await ui(`${statusPath}/confirm`, { request_id: pending.id })
      expect(confirmed.status, JSON.stringify(confirmed.data)).toBe(200)
      expect(confirmed.data.thread_id).toBe(threadId)
      expect(confirmed.data.runtime_port).toBe(Number(new URL(server.baseUrl).port))
      expect(
        server.store.getActiveRunByAgentId(workspaceId, `${workspaceId}:orchestrator`)
      ).toBeUndefined()
      await expect(
        action(
          'spawn',
          { role: 'coder', cli: 'codex', name: 'Wrong', operation_id: 'wrong' },
          randomUUID()
        )
      ).rejects.toThrow()
      expect(server.store.listWorkers(workspaceId)).toHaveLength(0)

      const member = await ui(`/api/workspaces/${workspaceId}/workers`, {
        name: 'Probe',
        role: 'coder',
        autostart: false,
        startup_command: [
          process.execPath,
          resolve('tests/fixtures/controller/member.mjs'),
          resolve('node_modules/tsx/dist/loader.mjs'),
          resolve('bin/team'),
        ]
          .map((part) => JSON.stringify(part))
          .join(' '),
      })
      expect(member.status).toBe(201)
      await action('start', { worker_name: 'Probe', operation_id: 'start' })
      // Capability was checked successfully; removing its executable now produces
      // a real ENOENT notification failure without notifying any user's App.
      unlinkSync(codex)
      vi.stubEnv('PATH', bin)
      const send = {
        worker_name: 'Probe',
        text: 'Return the protocol result.',
        operation_id: 'send',
      }
      const simultaneous = await Promise.allSettled([action('send', send), action('send', send)])
      const successful = simultaneous.filter(
        (result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled'
      )
      expect(successful.length).toBeGreaterThan(0)
      const successfulSend = successful[0]
      if (!successfulSend) throw new Error('Expected a successful dispatch')
      const first = successfulSend.value as { dispatch_id: string }
      // Either request may win; pending/409 is valid, a second dispatch is not.
      for (const result of successful) expect(result.value).toEqual(first)
      expect(server.store.listRecentDispatches(workspaceId)).toHaveLength(1)
      expect(await action('send', send)).toEqual(first)
      await expect(action('send', { ...send, text: 'different' })).rejects.toThrow()
      await vi.waitFor(
        async () => {
          expect((await ui(statusPath)).data.notification_error).toBeTruthy()
          expect(
            server?.store.listRecentDispatches(workspaceId).find((d) => d.id === first.dispatch_id)
              ?.status
          ).toBe('reported')
        },
        { timeout: 10000, interval: 50 }
      )
      expect((await ui(`${statusPath}/disconnect`, {})).status).toBe(409)
      await server.close()
      server = await startTestServer({ dataDir })
      cookie = await getUiCookie(server.baseUrl)
      expect((await ui(statusPath)).data).toMatchObject({ thread_id: threadId, pending_reports: 1 })
      expect(await action('send', send)).toEqual(first)
      expect(server.store.listRecentDispatches(workspaceId)).toHaveLength(1)
      const reports = (await action('read_reports')) as {
        reports: Array<{ id: number; result: string; dispatch_id: string }>
      }
      expect(reports.reports).toEqual([
        expect.objectContaining({
          dispatch_id: first.dispatch_id,
          result: 'CONTROLLER_PTY_RESULT',
        }),
      ])
      await action('ack_reports', { report_ids: reports.reports.map((report) => report.id) })
      expect((await ui(statusPath)).data.pending_reports).toBe(0)
      await action('ack_reports', { report_ids: reports.reports.map((report) => report.id) })
      expect(server.store.listRecentDispatches(workspaceId)).toHaveLength(1)

      await action('start', { worker_name: 'Probe', operation_id: 'start-again' })
      const held = (await action('send', {
        worker_name: 'Probe',
        text: 'HOLD_FOR_CANCEL',
        operation_id: 'hold',
      })) as { dispatch_id: string }
      await action('stop', { worker_name: 'Probe', operation_id: 'stop' })
      await vi.waitFor(
        async () => {
          const result = (await action('read_reports')) as {
            reports: Array<{ kind: string; dispatch_id: string }>
          }
          expect(result.reports).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: 'member_exit', dispatch_id: held.dispatch_id }),
            ])
          )
        },
        { timeout: 5000, interval: 50 }
      )
      expect(server.store.listOpenDispatches(workspaceId).map((d) => d.id)).toContain(
        held.dispatch_id
      )
      await action('cancel', {
        dispatch_id: held.dispatch_id,
        reason: 'explicit cancellation',
        operation_id: 'cancel',
      })
      const cancelled = (await action('read_reports')) as {
        reports: Array<{ id: number; status: string; dispatch_id: string }>
      }
      expect(cancelled.reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dispatch_id: held.dispatch_id, status: 'cancelled' }),
        ])
      )
      await action('start', { worker_name: 'Probe', operation_id: 'start-after-cancel' })
      const late = await fetch(`${server.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: member.data.id,
          token: server.store.peekAgentToken(member.data.id),
          dispatch_id: held.dispatch_id,
          result: 'LATE_RESULT_MUST_NOT_REPLACE_CANCELLATION',
        }),
      })
      expect(late.status).toBe(409)
      const afterLate = (await action('read_reports')) as { reports: unknown[] }
      expect(afterLate.reports).toEqual(cancelled.reports)
      expect(
        server.store.listRecentDispatches(workspaceId).find((d) => d.id === held.dispatch_id)
          ?.status
      ).toBe('cancelled')
      await action('ack_reports', { report_ids: cancelled.reports.map((report) => report.id) })
      await vi.waitFor(async () => expect((await ui(statusPath)).data.can_disconnect).toBe(true))
      const disconnected = await ui(`${statusPath}/disconnect`, {})
      expect(disconnected.status).toBe(200)
      expect(disconnected.data.thread_id).toBeNull()
      await expect(action('send', { ...send, operation_id: 'stale' })).rejects.toThrow()
      expect(server.store.listRecentDispatches(workspaceId)).toHaveLength(2)
    }, 30000)
  }
)
