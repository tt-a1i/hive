import type { DispatchRecord } from './dispatch-ledger-store.js'

export const serializeDispatchRecord = (record: DispatchRecord) => ({
  artifacts: record.artifacts,
  created_at: record.createdAt,
  delivered_at: record.deliveredAt,
  from_agent_id: record.fromAgentId,
  id: record.id,
  reported_at: record.reportedAt,
  report_text: record.reportText,
  state: record.status,
  submitted_at: record.submittedAt,
  text: record.text,
  to_agent_id: record.toAgentId,
  workspace_id: record.workspaceId,
})
