import * as Dialog from '@radix-ui/react-dialog'
import { MessageCircle } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'

import type { StartDiscussionInput } from './api.js'

export interface DiscussionTemplateInfo {
  id: string
  defaultRounds: number
  topicPromptHint: string
}

const templates: DiscussionTemplateInfo[] = [
  { id: 'design-review', defaultRounds: 3, topicPromptHint: '' },
  { id: 'root-cause-debate', defaultRounds: 2, topicPromptHint: '' },
  { id: 'risk-review', defaultRounds: 2, topicPromptHint: '' },
  { id: 'compare-approaches', defaultRounds: 3, topicPromptHint: '' },
]

type DiscussionStartDialogProps = {
  workers: TeamListItem[]
  onStart: (input: StartDiscussionInput) => Promise<void>
  onClose: () => void
  open: boolean
  loading?: boolean
}

export const DiscussionStartDialog = ({
  workers,
  onStart,
  onClose,
  open,
  loading = false,
}: DiscussionStartDialogProps) => {
  const { t } = useI18n()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [topic, setTopic] = useState('')
  const [rounds, setRounds] = useState(3)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [orchParticipates, setOrchParticipates] = useState(false)

  const selectTemplate = (id: string | null) => {
    setTemplateId(id)
    if (id) {
      const tpl = templates.find((t2) => t2.id === id)
      if (tpl) setRounds(tpl.defaultRounds)
    }
  }

  const toggleMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (selectedIds.size < 2 || !topic.trim()) return
    await onStart({
      members: Array.from(selectedIds),
      topic: topic.trim(),
      rounds,
      ...(templateId ? { templateId } : {}),
      ...(orchParticipates ? { orchParticipates: true } : {}),
    })
    setSelectedIds(new Set())
    setTopic('')
    setRounds(3)
    setTemplateId(null)
    setOrchParticipates(false)
  }

  const availableWorkers = workers.filter((w) => w.status !== 'stopped')
  const canSubmit = selectedIds.size >= 2 && topic.trim().length > 0 && !loading

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-content--md" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">
            <MessageCircle size={16} className="mr-2 inline" />
            {t('discussion.startDialog.title')}
          </Dialog.Title>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-sec">
                {t('discussion.startDialog.template')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => selectTemplate(null)}
                  className={`rounded border px-3 py-2 text-left text-xs ${
                    templateId === null
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-border hover:bg-surface-secondary'
                  }`}
                >
                  <span className="font-medium">{t('discussion.template.none')}</span>
                </button>
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => selectTemplate(tpl.id)}
                    className={`rounded border px-3 py-2 text-left text-xs ${
                      templateId === tpl.id
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-border hover:bg-surface-secondary'
                    }`}
                  >
                    <span className="font-medium">
                      {t(`discussion.template.${tpl.id}.name` as 'discussion.template.design-review.name')}
                    </span>
                    <p className="mt-0.5 text-ter">
                      {t(`discussion.template.${tpl.id}.desc` as 'discussion.template.design-review.desc')}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-sec">
                {t('discussion.startDialog.topic')}
              </label>
              <textarea
                className="input min-h-[72px] resize-y"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={
                  templateId
                    ? t(`discussion.template.${templateId}.hint` as 'discussion.template.design-review.hint')
                    : t('discussion.startDialog.topicPlaceholder')
                }
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-sec">
                {t('discussion.startDialog.members')} ({selectedIds.size})
              </label>
              <div className="flex max-h-[160px] flex-col gap-1 overflow-y-auto rounded border border-border p-2">
                {availableWorkers.map((w) => (
                  <label
                    key={w.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(w.id)}
                      onChange={() => toggleMember(w.id)}
                      className="accent-blue-500"
                    />
                    <span className="text-sm text-pri">{w.name}</span>
                    <span className="text-xs text-ter">({t(`role.${w.role}` as 'role.coder')})</span>
                  </label>
                ))}
                {availableWorkers.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-ter">
                    {t('discussion.startDialog.noWorkers')}
                  </p>
                ) : null}
              </div>
              {selectedIds.size > 0 && selectedIds.size < 2 ? (
                <p className="text-xs text-orange-500">
                  {t('discussion.startDialog.minMembers')}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-sec">
                {t('discussion.startDialog.rounds')}
              </label>
              <input
                type="number"
                className="input w-20"
                min={1}
                max={10}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={orchParticipates}
                  onChange={(e) => setOrchParticipates(e.target.checked)}
                  className="accent-blue-500"
                />
                <span className="text-xs font-medium text-sec">
                  {t('discussion.startDialog.orchParticipates')}
                </span>
              </label>
              <p className="pl-5 text-xs text-ter">
                {t('discussion.startDialog.orchParticipatesHint')}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--ghost">
                  {t('common.cancel')}
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
                {loading
                  ? t('discussion.startDialog.starting')
                  : t('discussion.startDialog.start')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
