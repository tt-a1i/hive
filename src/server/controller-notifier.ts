import { execFile } from 'node:child_process'
import { controllerReceiptPendingSql } from './controller-receipt-policy.js'
import type { Database } from './sqlite.js'

/** One attempt per persisted batch. Unknown outcomes are retained, never blindly resent. */
export const createControllerNotifier = (db: Database) => {
  let closing = false
  let active: Promise<void> | undefined
  let capabilityValidUntil = 0
  const capabilityChecks = new Set<Promise<void>>()
  const connecting = new Set<string>()
  const requireCapability = async () => {
    if (closing) throw new Error('Hive runtime is closing')
    if (Date.now() < capabilityValidUntil) return
    const check = new Promise<void>((resolve, reject) => {
      execFile(
        'codex',
        ['queue', '--help'],
        { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true },
        (error) => {
          if (error)
            reject(
              new Error(
                'The Hive runtime cannot run codex queue. Install a supported Codex CLI and ensure codex is on its PATH, then confirm again.'
              )
            )
          else {
            capabilityValidUntil = Date.now() + 60_000
            resolve()
          }
        }
      )
    })
    capabilityChecks.add(check)
    try {
      await check
    } finally {
      capabilityChecks.delete(check)
    }
  }
  const notifyConnected = (workspaceId: string, threadId: string): Promise<void> => {
    if (closing) return Promise.reject(new Error('Hive runtime is closing'))
    const state = db.prepare(
      'UPDATE workspace_controllers SET connection_error = ? WHERE workspace_id = ? AND thread_id = ?'
    )
    connecting.add(workspaceId)
    const previous = active
    const attempt = (async () => {
      await Promise.allSettled(previous ? [previous] : [])
      await new Promise<void>((resolve, reject) => {
        execFile(
          'codex',
          [
            'queue',
            '--thread',
            threadId,
            '--message',
            `Hive workspace ${workspaceId}: your controller connection is confirmed. Use hive.controller_action with action inspect to read the current project and existing team before continuing the user's task. Choose existing members only when their work benefits the task; preserve the user's CLI and model choices. Explain resource gaps instead of automatically adding members. If there is no concrete task, acknowledge readiness without dispatching work.`,
          ],
          { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
          (error) => {
            try {
              const message = error
                ? error.code === 'ENOENT' || error.code === 'EACCES'
                  ? 'Controller is bound, but its initial notification could not start. Use inspect in the bound task.'
                  : 'Controller is bound, but the initial notification outcome is unknown. Use inspect in the bound task; do not reconnect or repeat work.'
                : null
              state.run(message, workspaceId, threadId)
              resolve()
            } catch (persistenceError) {
              reject(persistenceError)
            }
          }
        )
      })
    })().finally(() => {
      connecting.delete(workspaceId)
      if (active === attempt) active = undefined
    })
    active = attempt
    return attempt
  }
  db.prepare(
    "UPDATE report_outbox SET notification_state = 'unknown', notification_error = 'Hive restarted during notification; read the pending reports in Codex App' WHERE notification_state = 'sending'"
  ).run()
  db.prepare("UPDATE controller_operations SET state = 'unknown' WHERE state = 'pending'").run()
  const notify = () => {
    if (closing || active) return
    const row = db
      .prepare(`SELECT o.workspace_id, c.thread_id FROM report_outbox o
      JOIN workspace_controllers c ON c.workspace_id = o.workspace_id
      JOIN workspaces w ON w.id = o.workspace_id
      WHERE w.controller_mode = 'codex_app' AND c.thread_id IS NOT NULL
        AND o.target_agent_id = o.workspace_id || ':orchestrator'
        AND ${controllerReceiptPendingSql} AND o.read_at IS NULL AND o.notification_state = 'pending'
      ORDER BY o.id LIMIT 1`)
      .get() as { workspace_id: string; thread_id: string } | undefined
    if (!row) return
    const ids = (
      db
        .prepare(`SELECT id FROM report_outbox o WHERE workspace_id = ?
      AND target_agent_id = ? AND ${controllerReceiptPendingSql} AND read_at IS NULL AND notification_state = 'pending'
      ORDER BY id LIMIT 100`)
        .all(row.workspace_id, `${row.workspace_id}:orchestrator`) as { id: number }[]
    ).map((item) => item.id)
    const state = db.prepare(
      'UPDATE report_outbox SET notification_state = ?, notification_error = ? WHERE id = ?'
    )
    db.transaction(() => {
      for (const id of ids) state.run('sending', null, id)
    })()
    const attempt = new Promise<void>((resolve, reject) => {
      // IDs are runtime data, never shell source. Full member text stays in SQLite.
      execFile(
        'codex',
        [
          'queue',
          '--thread',
          row.thread_id,
          '--message',
          `Hive workspace ${row.workspace_id} queued a notification for report_ids=${JSON.stringify(ids)}. If this conversation already acknowledged these IDs, ignore this delayed notification. Otherwise use hive.controller_action with action read_reports, inspect the receipts, then use action ack_reports for the IDs you read. You may acknowledge before answering; acknowledgement only confirms receipt and does not answer questions or approve work. Answer separately with action reply, question_id, text and operation_id when you have the needed context. Unanswered questions remain actionable in inspect/messages. An empty read means no pending receipts now: end this notification without polling or redispatching work. Do not create another Hive controller.`,
        ],
        { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
        (error) => {
          try {
            if (error) {
              const code = error.code
              const definiteFailure = code === 'ENOENT' || code === 'EACCES'
              const message = definiteFailure
                ? 'Codex notification could not start. Ensure codex is available to the Hive runtime; pending reports remain readable.'
                : 'Codex notification outcome is unknown. Read pending reports in the bound task before retrying work.'
              db.transaction(() => {
                for (const id of ids) state.run(definiteFailure ? 'failed' : 'unknown', message, id)
              })()
            } else {
              db.transaction(() => {
                for (const id of ids) state.run('accepted', null, id)
              })()
            }
            resolve()
          } catch (persistenceError) {
            reject(persistenceError)
          }
        }
      )
    })
      .catch((error) => {
        console.error('[hive] failed to persist Codex notification receipt', error)
      })
      .finally(() => {
        if (active === attempt) active = undefined
      })
    active = attempt
  }
  return {
    notify,
    notifyConnected,
    isConnecting: (workspaceId: string) => connecting.has(workspaceId),
    requireCapability,
    close: async () => {
      closing = true
      await Promise.allSettled([...capabilityChecks, ...(active ? [active] : [])])
    },
  }
}
