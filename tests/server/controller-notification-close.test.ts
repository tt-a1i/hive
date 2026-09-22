import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { callHiveMcpTool } from '../../src/cli/hive-mcp.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test.skipIf(process.platform === 'win32')(
  'close waits for an active notification receipt and restart does not resend the unread result',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-controller-close-'))
    const dataDir = join(root, 'data')
    const bin = join(root, 'bin')
    const marker = join(root, 'notifications')
    const release = join(root, 'release')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'codex'),
      `#!${process.execPath}\nimport ${JSON.stringify(resolve('tests/fixtures/controller/notification.mjs'))}\n`,
      { mode: 0o755 }
    )
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv('HIVE_TEST_NOTIFICATION_MARKER', marker)
    vi.stubEnv('HIVE_TEST_NOTIFICATION_RELEASE', release)
    let server: Awaited<ReturnType<typeof startTestServer>> | undefined
    let db: Database | undefined
    let closing: Promise<void> | undefined
    try {
      server = await startTestServer({ dataDir })
      const cookie = await getUiCookie(server.baseUrl)
      const ui = async (path: string, body: unknown) => {
        const response = await fetch(`${server?.baseUrl}${path}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: response.status, data: await response.json() }
      }
      const created = await ui('/api/workspaces', {
        path: root,
        name: 'Notification close',
        controller_mode: 'codex_app',
      })
      expect(created.status).toBe(201)
      const workspaceId = created.data.id as string
      const threadId = randomUUID()
      const mcp = (name: string, args: Record<string, unknown>) => {
        if (!server) throw new Error('Controller test server is not running')
        return callHiveMcpTool(name, args, {
          baseUrl: server.baseUrl,
          metadata: { threadId },
        })
      }
      const action = (name: string, args: Record<string, unknown> = {}) =>
        mcp('hive.controller_action', { workspace_id: workspaceId, action: name, ...args })
      const connected = (await mcp('hive.controller_connect', {
        workspace_id: workspaceId,
      })) as { pending_request: { id: string } }
      expect(
        (
          await ui(`/api/workspaces/${workspaceId}/controller/confirm`, {
            request_id: connected.pending_request.id,
          })
        ).status
      ).toBe(200)
      const member = await ui(`/api/workspaces/${workspaceId}/workers`, {
        name: 'CloseProbe',
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
      await action('start', { worker_name: 'CloseProbe', operation_id: 'start' })
      const sent = (await action('send', {
        worker_name: 'CloseProbe',
        operation_id: 'send',
        text: 'Report before notification close.',
      })) as { dispatch_id: string }
      db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
      const receipt = () =>
        db
          ?.prepare(
            'SELECT id, notification_state, read_at, payload FROM report_outbox WHERE dispatch_id = ?'
          )
          .get(sent.dispatch_id)
      await vi.waitFor(
        () => {
          expect(existsSync(marker)).toBe(true)
          expect(receipt()).toMatchObject({
            notification_state: 'sending',
            read_at: null,
            payload: expect.stringContaining('CONTROLLER_PTY_RESULT'),
          })
        },
        { timeout: 10000, interval: 25 }
      )
      const queued = JSON.parse(readFileSync(marker, 'utf8').trim()) as { args: string[] }
      expect(queued.args.slice(0, 3)).toEqual(['queue', '--thread', threadId])
      const notificationText = queued.args[queued.args.indexOf('--message') + 1]
      const reportId = (receipt() as { id: number }).id
      expect(notificationText).toContain(`report_ids=${JSON.stringify([reportId])}`)
      let closed = false
      closing = server.close().then(() => {
        closed = true
      })
      // The child is deliberately held; closing must not finish or lose its DB.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(closed).toBe(false)
      expect(receipt()).toMatchObject({ notification_state: 'sending', read_at: null })
      writeFileSync(release, '')
      await closing
      closing = undefined
      server = undefined
      expect(receipt()).toMatchObject({ notification_state: 'accepted', read_at: null })
      server = await startTestServer({ dataDir })
      // Keep the result unread across a complete notification scheduler tick.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1)
      expect(receipt()).toMatchObject({ notification_state: 'accepted', read_at: null })
      const reports = (await action('read_reports')) as { reports: Array<{ result: string }> }
      expect(reports.reports.map((report) => report.result)).toEqual(['CONTROLLER_PTY_RESULT'])
    } finally {
      writeFileSync(release, '')
      if (closing) await closing
      else await server?.close()
      db?.close()
      vi.unstubAllEnvs()
      removeTestPath(root)
    }
  },
  20000
)
