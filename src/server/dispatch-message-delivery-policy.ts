import type { Database } from './sqlite.js'

// Correlated to message alias m: evaluate a candidate's eligibility without
// materializing every historical message in every workspace.
export const dispatchMessageEligibilitySql = `EXISTS (
  SELECT 1 FROM dispatches target
  LEFT JOIN dispatches source ON source.id = m.source_dispatch_id
  WHERE target.id = m.dispatch_id
    AND (m.kind != 'question' OR target.status != 'cancelled')
    AND (m.recipient_agent_id = m.workspace_id || ':orchestrator' OR EXISTS (
      SELECT 1 FROM workers recipient WHERE recipient.workspace_id = m.workspace_id AND recipient.id = m.recipient_agent_id
    )) AND (
      m.recipient_agent_id = m.workspace_id || ':orchestrator'
      OR target.status IN ('queued','submitted')
      OR (target.status = 'reported' AND m.kind = 'question')
    ) AND (
      m.kind != 'question' OR m.source_dispatch_id IS NULL
      OR source.status IN ('queued','submitted')
    )
)`

export const isDispatchMessageEligible = (db: Database, messageId: string) =>
  db
    .prepare(
      `SELECT m.id FROM dispatch_messages m WHERE m.id = ? AND ${dispatchMessageEligibilitySql}`
    )
    .get(messageId) !== undefined

export const retireClosedDispatchMessages = (db: Database, dispatchId: string) => {
  db.prepare(`UPDATE dispatch_message_outbox SET state = 'cancelled'
    WHERE state IN ('queued','delivering') AND message_id IN (
      SELECT m.id FROM dispatch_messages m WHERE (m.dispatch_id = ? OR m.source_dispatch_id = ?)
      AND NOT (${dispatchMessageEligibilitySql})
    )`).run(dispatchId, dispatchId)
}
