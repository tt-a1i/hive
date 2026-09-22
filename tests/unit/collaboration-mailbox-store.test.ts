import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createDispatchMessageStore } from '../../src/server/dispatch-message-store.js'
import { ConflictError } from '../../src/server/http-errors.js'
import { createMailboxStore } from '../../src/server/mailbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const fixture = () => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  db.exec(`INSERT INTO workspaces(id,name,path,created_at) VALUES ('ws','Workspace','/tmp',1);
    INSERT INTO workers(id,workspace_id,name,role,created_at) VALUES ('worker','ws','Worker','coder',1);`)
  const dispatch = createDispatchLedgerStore(db).createDispatch({
    workspaceId: 'ws',
    toAgentId: 'worker',
    fromAgentId: 'ws:orchestrator',
    text: 'Task',
  })
  const messages = createDispatchMessageStore(db)
  const mailbox = createMailboxStore(db)
  const insert = (text: string, kind: 'note' | 'question' = 'note') =>
    messages.insert({
      workspaceId: 'ws',
      dispatchId: dispatch.id,
      sourceDispatchId: null,
      fromAgentId: 'ws:orchestrator',
      recipientAgentId: 'worker',
      kind,
      replyTo: null,
      text,
    })
  return { messages, mailbox, insert, dispatch }
}

test('mailbox returns at most 50 messages and leaves the remainder for the next receipt', () => {
  const { mailbox, insert } = fixture()
  const sent = Array.from({ length: 51 }, (_, index) => insert(`input ${index}`))
  const batch = mailbox.readMailbox('ws', 'worker')
  expect(batch.messages.map((message) => message.id)).toEqual(
    sent.slice(0, 50).map((message) => message.id)
  )
  if (!batch.batchId) throw new Error('Expected a batch receipt')
  mailbox.acknowledgeMailbox('ws', 'worker', batch.batchId)
  expect(mailbox.readMailbox('ws', 'worker').messages.map((message) => message.id)).toEqual([
    sent[50].id,
  ])
})

test('mailbox budgets UTF-8 bytes and returns a single oversized message intact', () => {
  const { mailbox, insert } = fixture()
  const sent = ['界'.repeat(12000), '界'.repeat(12000), '界'.repeat(30000), 'tail'].map((text) =>
    insert(text)
  )
  for (const message of sent) {
    const batch = mailbox.readMailbox('ws', 'worker')
    expect(batch.messages.map((item) => ({ id: item.id, text: item.text }))).toEqual([
      { id: message.id, text: message.text },
    ])
    if (!batch.batchId) throw new Error('Expected a batch receipt')
    mailbox.acknowledgeMailbox('ws', 'worker', batch.batchId)
  }
  expect(mailbox.readMailbox('ws', 'worker')).toEqual({ batchId: null, messages: [] })
})

test('sent-question history paginates without duplicates and rejects another sender cursor', () => {
  const { messages, insert, dispatch } = fixture()
  const sent = Array.from({ length: 51 }, (_, index) => insert(`question ${index}`, 'question'))
  messages.claim(sent[50].id)
  messages.delivered(sent[50].id)
  messages.claim(sent[49].id)
  messages.failed(sent[49].id, 'delivery interrupted')
  const first = messages.listSentQuestions('ws', 'ws:orchestrator')
  expect(first.questions).toEqual(
    sent
      .slice(1)
      .reverse()
      .map((question) => ({
        ...question,
        ...(question.id === sent[50].id
          ? { deliveryState: 'delivered', deliveredAt: expect.any(Number) }
          : {}),
        ...(question.id === sent[49].id ? { deliveryError: 'delivery interrupted' } : {}),
      }))
  )
  expect(messages.listSentQuestions('ws', 'ws:orchestrator', dispatch.id)).toEqual(first)
  expect(messages.listSentQuestions('ws', 'ws:orchestrator', 'another-dispatch').questions).toEqual(
    []
  )
  expect(messages.listSentQuestions('another-workspace', 'ws:orchestrator').questions).toEqual([])
  expect(first.nextBefore).toBe(sent[1].id)
  const older = messages.listSentQuestions(
    'ws',
    'ws:orchestrator',
    undefined,
    first.nextBefore ?? undefined
  )
  expect(older.questions).toEqual([sent[0]])
  expect(older.nextBefore).toBe(null)
  expect(messages.listSentQuestions('ws', 'worker').questions).toEqual([])
  expect(() => messages.listSentQuestions('ws', 'worker', undefined, sent[1].id)).toThrow(
    ConflictError
  )
})
