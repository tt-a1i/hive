import type { DispatchRecord } from './dispatch-ledger-store.js'

export const serializeDispatchRecord = (record: DispatchRecord) => ({
  outcome: record.outcome ?? null,
  delegated_from_id: record.delegatedFromId ?? null,
  parent_dispatch_id: record.parentDispatchId ?? null,
  root_dispatch_id: record.rootDispatchId ?? record.id,
  seen_seq: record.seenSeq ?? 0,
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
