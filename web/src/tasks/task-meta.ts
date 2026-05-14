/* Parses the trailing `(owner: …, status: …, 报告: …, …)` block that
   Orchestrators routinely append to a task title and pulls each piece
   into a structured chip. Loose by design: unknown keys fall through as
   plain `note` chips so a custom orchestrator format still renders. */

export type PillTone = 'green' | 'orange' | 'red' | 'neutral'

export type TaskMetaItem =
  | { kind: 'owner'; value: string }
  | { kind: 'status'; value: string; tone: PillTone }
  | { kind: 'path'; label: string; value: string }
  | { kind: 'note'; value: string }

const STATUS_TONES: Array<{ pattern: RegExp; tone: PillTone }> = [
  // Done / success — green
  { pattern: /^(done|completed?|finished?|ok|success|完成|已完成|搞定)$/i, tone: 'green' },
  // In progress / dispatched — orange
  {
    pattern:
      /^(working|running|in[-_ ]?progress|dispatching|dispatched|进行中|派单中?|执行中|处理中)$/i,
    tone: 'orange',
  },
  // Failed / blocked — red
  { pattern: /^(blocked|failed|error|errored|阻塞|失败|出错)$/i, tone: 'red' },
  // Open / queued / pending — neutral
  {
    pattern: /^(queued|waiting|pending|todo|open|idle|待办|等待中?|队列中|未开始)$/i,
    tone: 'neutral',
  },
]

const OWNER_KEYS = new Set(['owner', 'assignee', '负责', '负责人', '执行人'])
const STATUS_KEYS = new Set(['status', '状态'])
const PATH_KEYS = new Set(['报告', 'report', '文件', 'file', 'path', '日志', 'log', '产物'])

const META_TAIL_RE = /^(.*?)\s*\(([^()]+)\)\s*$/
const SEPARATOR_RE = /\s*[·,，;；]\s*/
const KV_RE = /^([^:：]+)[:：]\s*(.+)$/

const inferStatusTone = (value: string): PillTone => {
  for (const { pattern, tone } of STATUS_TONES) {
    if (pattern.test(value)) return tone
  }
  return 'neutral'
}

const looksLikePath = (value: string): boolean => {
  if (value.includes('/')) return true
  // bare-extension form: `notes.md`, `report.txt`
  return /^[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(value)
}

export const parseTaskMetadata = (text: string): { title: string; meta: TaskMetaItem[] } => {
  const match = text.match(META_TAIL_RE)
  if (!match) return { title: text, meta: [] }
  const [, titleRaw = '', body = ''] = match
  if (!body.trim()) return { title: text, meta: [] }

  const parts = body.split(SEPARATOR_RE).filter(Boolean)
  const meta: TaskMetaItem[] = []
  for (const part of parts) {
    const kv = part.match(KV_RE)
    if (!kv) {
      meta.push({ kind: 'note', value: part.trim() })
      continue
    }
    const key = (kv[1] ?? '').trim()
    const value = (kv[2] ?? '').trim()
    const keyLc = key.toLowerCase()
    if (OWNER_KEYS.has(keyLc) || OWNER_KEYS.has(key)) {
      meta.push({ kind: 'owner', value })
    } else if (STATUS_KEYS.has(keyLc) || STATUS_KEYS.has(key)) {
      meta.push({ kind: 'status', value, tone: inferStatusTone(value) })
    } else if (PATH_KEYS.has(keyLc) || PATH_KEYS.has(key) || looksLikePath(value)) {
      meta.push({ kind: 'path', label: key, value })
    } else {
      meta.push({ kind: 'note', value: `${key}: ${value}` })
    }
  }
  return { title: titleRaw.trim(), meta }
}
