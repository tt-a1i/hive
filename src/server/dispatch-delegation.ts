import { insertDispatchMessage } from './dispatch-message-store.js'
import { ConflictError, ForbiddenError } from './http-errors.js'
import type { Database } from './sqlite.js'

export const DELEGATION_LIMITS = {
  max_depth: 2,
  max_open_children: 3,
  max_total_children: 8,
} as const
interface OwnerRow {
  delivered_at: number | null
  id: string
  to_agent_id: string
  delegated_from_id: string | null
  status: string
}

export const validateDelegation = (
  db: Database,
  workspaceId: string,
  parentId: string,
  actorId: string | undefined,
  targetId: string
) => {
  const read = (id: string) =>
    db
      .prepare(
        'SELECT id,to_agent_id,delegated_from_id,status,delivered_at FROM dispatches WHERE workspace_id = ? AND id = ?'
      )
      .get(workspaceId, id) as OwnerRow | undefined
  const parent = read(parentId)
  if (!parent || parent.to_agent_id !== actorId)
    throw new ForbiddenError('Delegate only from a responsibility you own')
  if (parent.status !== 'submitted' || parent.delivered_at === null)
    throw new ConflictError('Delegation requires an open, delivered responsibility')
  let current = parent
  let depth = 1
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current.id) || current.to_agent_id === targetId)
      throw new ConflictError('Delegation cannot return to an ancestor member')
    visited.add(current.id)
    if (!current.delegated_from_id) break
    const ancestor = read(current.delegated_from_id)
    if (!ancestor) throw new ConflictError('Delegation ancestor no longer exists')
    current = ancestor
    depth += 1
  }
  if (depth > DELEGATION_LIMITS.max_depth) throw new ConflictError('Delegation depth limit reached')
  const children = db
    .prepare(
      "SELECT COUNT(*) AS count FROM dispatches WHERE delegated_from_id = ? AND status IN ('queued','submitted')"
    )
    .get(parentId) as { count: number }
  if (children.count >= DELEGATION_LIMITS.max_open_children)
    throw new ConflictError('Open delegation limit reached')
  const total = db
    .prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM dispatches WHERE delegated_from_id = ?
    UNION ALL SELECT d.id FROM dispatches d JOIN tree t ON d.delegated_from_id = t.id
  ) SELECT COUNT(*) AS count FROM tree`)
    .get(current.id) as { count: number }
  if (total.count >= DELEGATION_LIMITS.max_total_children)
    throw new ConflictError('Total delegation limit reached')
}

export const delegatedDescendantIds = (
  db: Database,
  workspaceId: string,
  parentId: string
): string[] =>
  (
    db
      .prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM dispatches WHERE workspace_id = ? AND delegated_from_id = ?
    UNION ALL SELECT d.id FROM dispatches d JOIN tree t ON d.delegated_from_id = t.id WHERE d.workspace_id = ?
  ) SELECT d.id FROM dispatches d JOIN tree t ON d.id = t.id WHERE d.status IN ('queued','submitted')`)
      .all(workspaceId, parentId, workspaceId) as { id: string }[]
  ).map((row) => row.id)

/** A child outcome is a durable input to its parent, committed with termination. */
export const recordDelegatedResult = (db: Database, workspaceId: string, childId: string) => {
  const child = db
    .prepare(`SELECT c.*, p.to_agent_id AS parent_owner, p.status AS parent_status
    FROM dispatches c JOIN dispatches p ON p.id = c.delegated_from_id
    WHERE c.workspace_id = ? AND c.id = ?`)
    .get(workspaceId, childId) as
    | {
        delegated_from_id: string
        to_agent_id: string
        parent_owner: string
        parent_status: string
        status: string
        outcome: string | null
        report_text: string | null
        artifacts: string | null
      }
    | undefined
  if (!child || !['queued', 'submitted'].includes(child.parent_status)) return
  const text = `Delegated task ${childId}: ${child.status}; outcome=${child.outcome ?? 'unknown'}\n${child.report_text ?? ''}\nArtifacts: ${child.artifacts ?? '[]'}`
  insertDispatchMessage(db, {
    workspaceId,
    dispatchId: child.delegated_from_id,
    sourceDispatchId: childId,
    fromAgentId: child.to_agent_id,
    recipientAgentId: child.parent_owner,
    kind: 'note',
    replyTo: null,
    text,
  })
}
