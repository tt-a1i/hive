import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export type TaskStatus = 'proposed' | 'open' | 'in_progress' | 'done' | 'blocked' | 'cancelled'
export type TaskSource = 'orch' | 'discussion' | 'user'
export type TaskEventType =
  | 'created'
  | 'dispatched'
  | 'report_suggested'
  | 'marked_done'
  | 'blocked'
  | 'cancelled'
  | 'relinked'
  | 'archived'

export interface TaskRecord {
  id: string
  workspaceId: string
  title: string
  status: TaskStatus
  source: TaskSource | null
  sourceRef: string | null
  seq: number
  createdAt: number
}

export interface TaskEventRecord {
  id: number
  workspaceId: string
  taskId: string
  eventType: TaskEventType
  agentId: string | null
  dispatchId: string | null
  payload: unknown | null
  lineSnapshot: string | null
  createdAt: number
}

interface TaskRow {
  id: string
  workspace_id: string
  title: string
  status: TaskStatus
  source: string | null
  source_ref: string | null
  seq: number
  created_at: number
}

interface TaskEventRow {
  id: number
  workspace_id: string
  task_id: string
  event_type: string
  agent_id: string | null
  dispatch_id: string | null
  payload: string | null
  line_snapshot: string | null
  created_at: number
}

interface DispatchMinimal {
  id: string
  status: string
  toAgentId: string
  text: string
  createdAt: number
}

const toTaskRecord = (row: TaskRow): TaskRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  status: row.status,
  source: row.source as TaskSource | null,
  sourceRef: row.source_ref,
  seq: row.seq,
  createdAt: row.created_at,
})

const toEventRecord = (row: TaskEventRow): TaskEventRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  taskId: row.task_id,
  eventType: row.event_type as TaskEventType,
  agentId: row.agent_id,
  dispatchId: row.dispatch_id,
  payload: row.payload ? JSON.parse(row.payload) : null,
  lineSnapshot: row.line_snapshot,
  createdAt: row.created_at,
})

export interface CreateTaskInput {
  workspaceId: string
  title: string
  source: TaskSource
  sourceRef?: string
  agentId?: string
}

export interface TaskWithDetails {
  task: TaskRecord
  dispatches: DispatchMinimal[]
  recentEvents: TaskEventRecord[]
}

export const createTaskService = (db: Database) => {
  const createTask = (input: CreateTaskInput): TaskRecord => {
    const id = randomUUID()
    const now = Date.now()
    const status: TaskStatus = input.source === 'discussion' ? 'proposed' : 'open'

    const { seq } = db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, source, source_ref, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks WHERE workspace_id = ?), ?)
       RETURNING seq`
    ).get(id, input.workspaceId, input.title, status, input.source, input.sourceRef ?? null, input.workspaceId, now) as { seq: number }

    db.prepare(
      `INSERT INTO task_events (workspace_id, task_id, event_type, agent_id, payload, created_at)
       VALUES (?, ?, 'created', ?, ?, ?)`
    ).run(input.workspaceId, id, input.agentId ?? null, null, now)

    return {
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      status,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      seq,
      createdAt: now,
    }
  }

  const listTasks = (
    workspaceId: string,
    filter?: { status?: TaskStatus }
  ): TaskRecord[] => {
    if (filter?.status) {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC')
        .all(workspaceId, filter.status) as TaskRow[]
      return rows.map(toTaskRecord)
    }
    const rows = db
      .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as TaskRow[]
    return rows.map(toTaskRecord)
  }

  const getTask = (taskId: string): TaskWithDetails | null => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) return null

    const dispatchRows = db
      .prepare(
        `SELECT id, status, to_agent_id, text, created_at FROM dispatches
         WHERE task_id = ? ORDER BY created_at DESC`
      )
      .all(taskId) as Array<{
      id: string
      status: string
      to_agent_id: string
      text: string
      created_at: number
    }>

    const eventRows = db
      .prepare(
        'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 20'
      )
      .all(taskId) as TaskEventRow[]

    return {
      task: toTaskRecord(row),
      dispatches: dispatchRows.map((d) => ({
        id: d.id,
        status: d.status,
        toAgentId: d.to_agent_id,
        text: d.text,
        createdAt: d.created_at,
      })),
      recentEvents: eventRows.map(toEventRecord),
    }
  }

  const updateTaskStatus = (
    taskId: string,
    status: TaskStatus,
    agentId?: string
  ): TaskRecord | null => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) return null

    const now = Date.now()
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId)

    const eventType: TaskEventType =
      status === 'done'
        ? 'marked_done'
        : status === 'blocked'
          ? 'blocked'
          : status === 'cancelled'
            ? 'cancelled'
            : 'dispatched'

    const payload =
      eventType === 'dispatched'
        ? JSON.stringify({ from: row.status, to: status })
        : null

    db.prepare(
      `INSERT INTO task_events (workspace_id, task_id, event_type, agent_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.workspace_id, taskId, eventType, agentId ?? null, payload, now)

    return { ...toTaskRecord(row), status }
  }

  const deleteTask = (taskId: string, agentId?: string): boolean => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) return false

    const now = Date.now()
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', taskId)

    db.prepare(
      `INSERT INTO task_events (workspace_id, task_id, event_type, agent_id, created_at)
       VALUES (?, ?, 'cancelled', ?, ?)`
    ).run(row.workspace_id, taskId, agentId ?? null, now)

    return true
  }

  const linkDispatchToTask = (
    dispatchId: string,
    taskId: string,
    agentId?: string
  ): boolean => {
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!taskRow) return false

    const now = Date.now()
    db.prepare('UPDATE dispatches SET task_id = ? WHERE id = ?').run(taskId, dispatchId)

    db.prepare(
      `INSERT INTO task_events (workspace_id, task_id, event_type, agent_id, dispatch_id, created_at)
       VALUES (?, ?, 'dispatched', ?, ?, ?)`
    ).run(taskRow.workspace_id, taskId, agentId ?? null, dispatchId, now)

    if (taskRow.status === 'open') {
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', taskId)
    }

    return true
  }

  const recordSuggestion = (
    taskId: string,
    dispatchId: string,
    payload: unknown,
    agentId?: string
  ): boolean => {
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!taskRow) return false

    const now = Date.now()
    db.prepare(
      `INSERT INTO task_events (workspace_id, task_id, event_type, agent_id, dispatch_id, payload, created_at)
       VALUES (?, ?, 'report_suggested', ?, ?, ?, ?)`
    ).run(
      taskRow.workspace_id,
      taskId,
      agentId ?? null,
      dispatchId,
      payload ? JSON.stringify(payload) : null,
      now
    )

    return true
  }

  const getTaskBySeq = (workspaceId: string, seq: number): TaskRecord | null => {
    const row = db
      .prepare('SELECT * FROM tasks WHERE workspace_id = ? AND seq = ?')
      .get(workspaceId, seq) as TaskRow | undefined
    return row ? toTaskRecord(row) : null
  }

  return {
    createTask,
    getTaskBySeq,
    listTasks,
    getTask,
    updateTaskStatus,
    deleteTask,
    linkDispatchToTask,
    recordSuggestion,
  }
}
