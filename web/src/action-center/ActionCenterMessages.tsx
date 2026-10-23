import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ActionCenterMessage } from '../../../src/shared/action-center.js'
import { useI18n } from '../i18n.js'
import {
  type MessageSelection,
  useActionCenterConversation,
} from './useActionCenterConversation.js'

export interface MessageRequest {
  dispatchId: string
  messageId?: string
}

export const ActionCenterMessages = ({
  messages,
  workspaceId,
  workers,
  request,
}: {
  messages: ActionCenterMessage[]
  workspaceId: string
  workers: Array<{ id: string; name: string }>
  request?: MessageRequest | null
}) => {
  const { t } = useI18n()
  const messagePrefix = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const responsibilityDetails = useRef<HTMLDetailsElement>(null)
  const [selection, setSelection] = useState<MessageSelection | null>(null)
  const history = useActionCenterConversation(workspaceId, selection)
  const page = history?.page
  const handledFocus = useRef<MessageSelection | null>(null)
  const visible = selection ? (page?.messages ?? []) : messages
  const messagesById = new Map(visible.map((message) => [message.id, message]))
  const focusMessage = (messageId: string, expand: boolean) => {
    const item = document.getElementById(`${messagePrefix}-${messageId}`)
    const details = item?.querySelector('details')
    if (details && expand) details.open = true
    item?.scrollIntoView({ block: 'nearest' })
    item?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (request) {
      setSelection(
        request.messageId
          ? {
              dispatchId: request.dispatchId,
              cursor: { aroundMessageId: request.messageId },
              focus: { messageId: request.messageId },
            }
          : { dispatchId: request.dispatchId }
      )
    }
  }, [request])
  useLayoutEffect(() => {
    if (selection && !selection.focus) {
      heading.current?.scrollIntoView({ block: 'nearest' })
      heading.current?.focus({ preventScroll: true })
    }
  }, [selection])
  useLayoutEffect(() => {
    if (!selection || !page || handledFocus.current === selection) return
    handledFocus.current = selection
    const target = selection.focus
    const id =
      typeof target === 'object'
        ? target.messageId
        : target === 'last'
          ? page.messages.at(-1)?.id
          : target === 'first'
            ? page.messages[0]?.id
            : undefined
    if (!id && typeof target !== 'object') {
      if (responsibilityDetails.current) responsibilityDetails.current.open = true
      heading.current?.scrollIntoView({ block: 'nearest' })
      heading.current?.focus({ preventScroll: true })
      return
    }
    if (id) focusMessage(id, typeof target === 'object')
  })

  if (messages.length === 0 && !selection) return null
  const responsibility = page?.related_dispatches.find((item) => item.id === selection?.dispatchId)
  const missingTarget =
    page && typeof selection?.focus === 'object' && !messagesById.has(selection.focus.messageId)
  const agentName = (id: string) =>
    id === `${workspaceId}:orchestrator`
      ? t('actionCenter.message.orchestrator')
      : (workers.find((worker) => worker.id === id)?.name ?? t('actionCenter.unknownWorker'))
  const openMessage = (dispatchId: string, messageId: string) => {
    if (messagesById.has(messageId)) focusMessage(messageId, true)
    else {
      setSelection({ dispatchId, cursor: { aroundMessageId: messageId }, focus: { messageId } })
    }
  }
  const retry = () => setSelection((previous) => (previous ? { ...previous } : null))

  return (
    <section className="action-center-panel min-w-0" data-testid="action-center-messages">
      <div className="action-center-panel__header">
        <h3 ref={heading} tabIndex={-1}>
          {t(selection ? 'actionCenter.message.historyTitle' : 'actionCenter.message.title')}
          {selection ? ` · ${selection.dispatchId.slice(0, 8)}` : ''}
        </h3>
        {selection ? (
          <button type="button" className="text-xs text-accent" onClick={() => setSelection(null)}>
            {t('actionCenter.message.recent')}
          </button>
        ) : null}
      </div>
      {history?.error || missingTarget ? (
        <p role="alert" className="mb-2 text-xs text-sec">
          {t(missingTarget ? 'actionCenter.message.notFound' : 'actionCenter.loadFailed')}{' '}
          <button type="button" className="text-accent" onClick={retry}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}
      {page ? (
        <div className="mb-3 space-y-2">
          <nav className="flex flex-wrap gap-2" aria-label={t('actionCenter.message.related')}>
            {page.related_dispatches.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === selection?.dispatchId}
                className="rounded border border-bright/40 px-2 py-1 text-xs text-sec aria-pressed:text-accent"
                onClick={() => setSelection({ dispatchId: item.id, focus: 'first' })}
              >
                {item.owner_name} · {item.id.slice(0, 8)}
              </button>
            ))}
          </nav>
          {responsibility ? (
            <details
              ref={responsibilityDetails}
              className="rounded border border-bright/40 px-2 py-1.5 text-xs text-sec"
            >
              <summary className="cursor-pointer">
                {t('actionCenter.message.responsibility')} · {responsibility.owner_name} ·{' '}
                {t(`actionCenter.activity.${responsibility.state}`, {
                  worker: responsibility.owner_name,
                  ago: '',
                })}
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{responsibility.text}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {selection && page?.previous_before_message_id ? (
        <button
          type="button"
          className="mb-2 text-xs text-accent"
          onClick={() =>
            setSelection({
              dispatchId: selection.dispatchId,
              cursor: { beforeMessageId: page.previous_before_message_id as string },
              focus: 'last',
            })
          }
        >
          {t('actionCenter.message.previous')}
        </button>
      ) : null}
      <ul
        className="max-h-80 space-y-2 overflow-auto"
        aria-busy={!!selection && !page && !history?.error}
      >
        {visible.map((message) => (
          <li key={message.id} id={`${messagePrefix}-${message.id}`} data-message-id={message.id}>
            <details className="rounded border border-bright/40 px-2 py-1.5">
              <summary className="cursor-pointer break-words text-xs text-sec">
                {t(`actionCenter.message.${message.kind}`)} · {message.dispatch_id.slice(0, 8)} ·{' '}
                {t(`actionCenter.message.${message.delivery_state}`)}
                <span className="mt-1 block line-clamp-2 text-ter">{message.text}</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-xs text-pri">
                {message.text}
              </p>
              <p className="mt-2 break-all text-[11px] text-ter">
                {agentName(message.from_agent_id)} → {agentName(message.recipient_agent_id)}
              </p>
              {message.reply_to ? (
                <p className="mt-2 text-xs text-sec">
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => openMessage(message.dispatch_id, message.reply_to as string)}
                  >
                    {t('actionCenter.message.replyTo')}
                  </button>
                  {messagesById.get(message.reply_to)?.text ? (
                    <span className="mt-1 block line-clamp-2">
                      {messagesById.get(message.reply_to)?.text}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {message.delivery_error ? (
                <p className="mt-1 break-words text-xs text-sec">{message.delivery_error}</p>
              ) : null}
              {!selection ? (
                <button
                  type="button"
                  className="mt-2 text-xs text-accent"
                  onClick={() =>
                    setSelection({
                      dispatchId: message.dispatch_id,
                      cursor: { aroundMessageId: message.id },
                      focus: { messageId: message.id },
                    })
                  }
                >
                  {t('actionCenter.message.history')}
                </button>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
      {selection && !page && !history?.error ? (
        <p role="status" className="mt-2 text-xs text-ter">
          {t('actionCenter.loading')}
        </p>
      ) : null}
      {selection && page?.next_after_message_id ? (
        <button
          type="button"
          className="mt-2 text-xs text-accent"
          onClick={() =>
            setSelection({
              dispatchId: selection.dispatchId,
              cursor: { afterMessageId: page.next_after_message_id as string },
              focus: 'first',
            })
          }
        >
          {t('actionCenter.message.more')}
        </button>
      ) : null}
    </section>
  )
}
