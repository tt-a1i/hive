import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach } from 'vitest'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTaskService } from '../../src/server/task-service.js'

describe('task-service', () => {
  let db: Database.Database
  let service: ReturnType<typeof createTaskService>
  const workspaceId = 'ws-test-001'

  beforeEach(() => {
    db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    service = createTaskService(db)
  })

  describe('createTask', () => {
    it('creates a task with open status for orch source', () => {
      const task = service.createTask({
        workspaceId,
        title: 'Implement feature X',
        source: 'orch',
      })

      expect(task.id).toBeTruthy()
      expect(task.workspaceId).toBe(workspaceId)
      expect(task.title).toBe('Implement feature X')
      expect(task.status).toBe('open')
      expect(task.source).toBe('orch')
      expect(task.sourceRef).toBeNull()
      expect(task.createdAt).toBeGreaterThan(0)
    })

    it('creates a task with proposed status for discussion source', () => {
      const task = service.createTask({
        workspaceId,
        title: 'Discussion outcome',
        source: 'discussion',
        sourceRef: 'disc-group-123',
      })

      expect(task.status).toBe('proposed')
      expect(task.sourceRef).toBe('disc-group-123')
    })

    it('records a created event', () => {
      const task = service.createTask({
        workspaceId,
        title: 'Test task',
        source: 'user',
        agentId: 'agent-001',
      })

      const details = service.getTask(task.id)
      expect(details).not.toBeNull()
      expect(details!.recentEvents).toHaveLength(1)
      expect(details!.recentEvents[0]!.eventType).toBe('created')
      expect(details!.recentEvents[0]!.agentId).toBe('agent-001')
    })
  })

  describe('listTasks', () => {
    it('lists all tasks for a workspace', () => {
      service.createTask({ workspaceId, title: 'Task 1', source: 'orch' })
      service.createTask({ workspaceId, title: 'Task 2', source: 'orch' })
      service.createTask({ workspaceId: 'other-ws', title: 'Task 3', source: 'orch' })

      const tasks = service.listTasks(workspaceId)
      expect(tasks).toHaveLength(2)
    })

    it('filters by status', () => {
      service.createTask({ workspaceId, title: 'Open task', source: 'orch' })
      service.createTask({ workspaceId, title: 'Proposed task', source: 'discussion' })

      const openTasks = service.listTasks(workspaceId, { status: 'open' })
      expect(openTasks).toHaveLength(1)
      expect(openTasks[0]!.title).toBe('Open task')

      const proposedTasks = service.listTasks(workspaceId, { status: 'proposed' })
      expect(proposedTasks).toHaveLength(1)
      expect(proposedTasks[0]!.title).toBe('Proposed task')
    })
  })

  describe('getTask', () => {
    it('returns null for non-existent task', () => {
      expect(service.getTask('non-existent')).toBeNull()
    })

    it('returns task with dispatches and events', () => {
      const task = service.createTask({ workspaceId, title: 'Detailed task', source: 'orch' })
      const details = service.getTask(task.id)

      expect(details).not.toBeNull()
      expect(details!.task.id).toBe(task.id)
      expect(details!.dispatches).toHaveLength(0)
      expect(details!.recentEvents).toHaveLength(1)
    })
  })

  describe('updateTaskStatus', () => {
    it('updates status and records event', () => {
      const task = service.createTask({ workspaceId, title: 'Task to update', source: 'orch' })

      const updated = service.updateTaskStatus(task.id, 'done', 'orch-agent')
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('done')

      const details = service.getTask(task.id)
      const doneEvent = details!.recentEvents.find((e) => e.eventType === 'marked_done')
      expect(doneEvent).toBeTruthy()
      expect(doneEvent!.agentId).toBe('orch-agent')
    })

    it('returns null for non-existent task', () => {
      expect(service.updateTaskStatus('fake-id', 'done')).toBeNull()
    })
  })

  describe('deleteTask', () => {
    it('sets status to cancelled and records event', () => {
      const task = service.createTask({ workspaceId, title: 'To delete', source: 'orch' })

      const result = service.deleteTask(task.id, 'orch-agent')
      expect(result).toBe(true)

      const details = service.getTask(task.id)
      expect(details!.task.status).toBe('cancelled')
      const cancelEvent = details!.recentEvents.find((e) => e.eventType === 'cancelled')
      expect(cancelEvent).toBeTruthy()
    })

    it('returns false for non-existent task', () => {
      expect(service.deleteTask('fake-id')).toBe(false)
    })
  })

  describe('linkDispatchToTask', () => {
    it('links dispatch and transitions open to in_progress', () => {
      const task = service.createTask({ workspaceId, title: 'Dispatchable', source: 'orch' })

      db.prepare(
        `INSERT INTO dispatches (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('dispatch-001', workspaceId, 'orch-agent', 'worker-1', 'Do something', 'queued', Date.now())

      const result = service.linkDispatchToTask('dispatch-001', task.id, 'orch-agent')
      expect(result).toBe(true)

      const details = service.getTask(task.id)
      expect(details!.task.status).toBe('in_progress')
      expect(details!.dispatches).toHaveLength(1)
      expect(details!.dispatches[0]!.id).toBe('dispatch-001')

      const dispatchedEvent = details!.recentEvents.find((e) => e.eventType === 'dispatched')
      expect(dispatchedEvent).toBeTruthy()
      expect(dispatchedEvent!.dispatchId).toBe('dispatch-001')
    })

    it('does not transition if task is already in_progress', () => {
      const task = service.createTask({ workspaceId, title: 'Already active', source: 'orch' })
      service.updateTaskStatus(task.id, 'in_progress')

      db.prepare(
        `INSERT INTO dispatches (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('dispatch-002', workspaceId, 'orch-agent', 'worker-2', 'More work', 'queued', Date.now())

      service.linkDispatchToTask('dispatch-002', task.id)

      const details = service.getTask(task.id)
      expect(details!.task.status).toBe('in_progress')
    })

    it('returns false for non-existent task', () => {
      expect(service.linkDispatchToTask('dispatch-x', 'fake-task')).toBe(false)
    })
  })

  describe('recordSuggestion', () => {
    it('records a report_suggested event without changing status', () => {
      const task = service.createTask({ workspaceId, title: 'Suggestible', source: 'orch' })

      const result = service.recordSuggestion(
        task.id,
        'dispatch-100',
        { summary: 'Worker thinks it is done' },
        'worker-agent'
      )
      expect(result).toBe(true)

      const details = service.getTask(task.id)
      expect(details!.task.status).toBe('open')
      const suggestEvent = details!.recentEvents.find((e) => e.eventType === 'report_suggested')
      expect(suggestEvent).toBeTruthy()
      expect(suggestEvent!.dispatchId).toBe('dispatch-100')
      expect(suggestEvent!.payload).toEqual({ summary: 'Worker thinks it is done' })
    })

    it('returns false for non-existent task', () => {
      expect(service.recordSuggestion('fake-id', 'dispatch-x', null)).toBe(false)
    })
  })
})
