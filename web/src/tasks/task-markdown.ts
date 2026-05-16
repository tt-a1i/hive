export interface ParsedTask {
  checked: boolean
  children: ParsedTask[]
  indent: number
  line: number
  mentions: string[]
  text: string
}

const TASK_LINE = /^(\s*)-\s+\[( |x|X)\]\s+(.*)$/

/**
 * Pulls candidate `@name` tokens out of a task title. Word-boundary-anchored
 * so things like `email@example.com` (where `@` is mid-word) don't false-match.
 * The token-shape regex is intentionally permissive — fail-soft filtering
 * against a workspace's actual worker names happens in `parseTaskMarkdown`.
 */
const MENTION_RE = /(?:^|[\s\p{P}])(@[A-Za-z0-9_-]+)/gu

const extractMentions = (text: string): string[] => {
  const matches: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1]) matches.push(m[1])
  }
  return matches
}

/**
 * Build a case-insensitive lookup once per parse so each mention candidate is
 * just a hash check. Keys are lowercased worker names; values are the original
 * cased form for downstream display.
 */
const buildWorkerLookup = (names: readonly string[]): Map<string, string> => {
  const lookup = new Map<string, string>()
  for (const name of names) {
    const trimmed = name.trim()
    if (trimmed) lookup.set(trimmed.toLowerCase(), trimmed)
  }
  return lookup
}

export interface ParseTaskMarkdownOptions {
  /**
   * When provided, only `@<name>` tokens whose lowercased form matches an
   * entry in this list are kept as `mentions`. Unknown / email-like tokens
   * (`email@example.com`, `@Unknown`, `@alice's task`) are dropped — they stay
   * in `text` and are rendered as plain markdown, not chips.
   *
   * Omit (or pass empty) to preserve the legacy "any `@token` is a mention"
   * behavior, useful in demos / fixtures where worker identity is mocked.
   */
  knownWorkerNames?: readonly string[]
}

export const parseTaskMarkdown = (
  content: string,
  options: ParseTaskMarkdownOptions = {}
): ParsedTask[] => {
  const root: ParsedTask[] = []
  const stack: ParsedTask[] = []
  const lines = content.split(/\r?\n/)
  const lookup = options.knownWorkerNames ? buildWorkerLookup(options.knownWorkerNames) : null
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (!rawLine) continue
    const match = rawLine.match(TASK_LINE)
    if (!match) continue
    const [, indentRaw = '', mark = ' ', textRaw = ''] = match
    const indent = indentRaw.replace(/\t/g, '  ').length
    const rawMentions = extractMentions(textRaw)
    let mentions: string[]
    if (lookup) {
      // Fail-soft: keep only `@name` tokens that resolve to a real worker.
      // Tokens that don't resolve stay in `text` so the reader still sees the
      // original prose (e.g. `email@example.com`) rather than a silent strip.
      mentions = []
      for (const candidate of rawMentions) {
        const cased = lookup.get(candidate.slice(1).toLowerCase())
        if (cased) mentions.push(`@${cased}`)
      }
    } else {
      // Legacy: every word-boundary `@token` is treated as a mention.
      mentions = rawMentions
    }
    // Strip *only* the resolved mentions from the visible text, using the same
    // word-boundary rule that `MENTION_RE` uses on the way in. Tokens that
    // weren't accepted as mentions (mid-word `@`, unknown names) stay in body
    // text so the reader still sees the original prose.
    let textWithoutMentions = textRaw
    for (const candidate of mentions) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      textWithoutMentions = textWithoutMentions.replace(
        new RegExp(`(?:^|(?<=\\s|\\p{P}))${escaped}(?!\\w)`, 'u'),
        ''
      )
    }
    textWithoutMentions = textWithoutMentions.replace(/\s+/g, ' ').trim()
    const task: ParsedTask = {
      checked: mark.toLowerCase() === 'x',
      children: [],
      indent,
      line: i,
      mentions,
      text: textWithoutMentions,
    }
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top && top.indent < indent) break
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(task)
    } else {
      root.push(task)
    }
    stack.push(task)
  }
  return root
}

/**
 * Direct-child progress for a parent task. Counts only the parent's
 * immediate `[ ]` / `[x]` children — not grandchildren, not bullets that
 * aren't checkbox tasks. Returns `null` when the parent has zero direct
 * checkbox children so callers can skip rendering a `0/0` badge.
 *
 * The "direct only" rule keeps the indicator predictable for parents that
 * decompose deeply: a "实现登录" parent with `- POST /login` + `- POST /logout`
 * subtasks reports `0/2` regardless of how those subtasks are further
 * decomposed under each endpoint.
 */
export const countDirectCheckboxChildren = (
  task: ParsedTask
): { done: number; total: number } | null => {
  if (task.children.length === 0) return null
  let done = 0
  for (const child of task.children) {
    if (child.checked) done += 1
  }
  return { done, total: task.children.length }
}

export const toggleTaskLine = (content: string, lineIndex: number): string => {
  const lines = content.split(/\r?\n/)
  const target = lines[lineIndex]
  if (target === undefined) return content
  const match = target.match(TASK_LINE)
  if (!match) return content
  const isChecked = (match[2] ?? ' ').toLowerCase() === 'x'
  const next = target.replace(TASK_LINE, (_, indent, _mark, text) => {
    return `${indent}- [${isChecked ? ' ' : 'x'}] ${text}`
  })
  lines[lineIndex] = next
  return lines.join('\n')
}

/** Collapse embedded newlines into spaces so a single task line stays a
 *  single physical line (defensive against paste-from-clipboard etc). */
const sanitizeTaskText = (text: string): string =>
  text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()

export const updateTaskTextAtLine = (
  content: string,
  lineIndex: number,
  nextText: string
): string => {
  const lines = content.split(/\r?\n/)
  const target = lines[lineIndex]
  if (target === undefined) return content
  const match = target.match(TASK_LINE)
  if (!match) return content
  const sanitized = sanitizeTaskText(nextText)
  if (!sanitized) return content
  const next = target.replace(TASK_LINE, (_, indent, mark) => {
    return `${indent}- [${mark}] ${sanitized}`
  })
  lines[lineIndex] = next
  return lines.join('\n')
}

/**
 * Drop the task at `lineIndex` and every nested-deeper sibling line beneath
 * it (until we encounter a peer or shallower line). Non-task neighbour lines
 * (blank, headings, prose) act as cascade terminators — keeping user-authored
 * context outside the deletion window. NOTE: prose lines interleaved BETWEEN
 * a parent task and its first child will currently orphan the child on
 * reparse; `.hive/tasks.md` is in practice a pure GFM checklist, so we defer
 * the look-ahead fix until a real workspace bumps into it.
 */
export const deleteTaskLine = (content: string, lineIndex: number): string => {
  const lines = content.split(/\r?\n/)
  const target = lines[lineIndex]
  if (target === undefined) return content
  const match = target.match(TASK_LINE)
  if (!match) return content
  const baseIndent = (match[1] ?? '').replace(/\t/g, '  ').length
  let end = lineIndex + 1
  while (end < lines.length) {
    const probe = lines[end]
    if (probe === undefined) break
    const childMatch = probe.match(TASK_LINE)
    if (!childMatch) break
    const childIndent = (childMatch[1] ?? '').replace(/\t/g, '  ').length
    if (childIndent <= baseIndent) break
    end += 1
  }
  lines.splice(lineIndex, end - lineIndex)
  return lines.join('\n')
}

/**
 * Insert a new task as a direct child of the task at `lineIndex`, placed
 * after any existing children of that task. The new line uses the parent's
 * indent + 2 spaces. Returns unchanged content if `lineIndex` doesn't point
 * at a task line.
 */
export const appendChildTaskAtLine = (content: string, lineIndex: number, text: string): string => {
  const sanitized = sanitizeTaskText(text)
  if (!sanitized) return content
  const lines = content.split(/\r?\n/)
  const target = lines[lineIndex]
  if (target === undefined) return content
  const match = target.match(TASK_LINE)
  if (!match) return content
  const parentIndentRaw = match[1] ?? ''
  const parentIndent = parentIndentRaw.replace(/\t/g, '  ').length
  let insertAt = lineIndex + 1
  while (insertAt < lines.length) {
    const probe = lines[insertAt]
    if (probe === undefined) break
    const childMatch = probe.match(TASK_LINE)
    if (!childMatch) break
    const childIndent = (childMatch[1] ?? '').replace(/\t/g, '  ').length
    if (childIndent <= parentIndent) break
    insertAt += 1
  }
  const childIndent = `${parentIndentRaw}  `
  lines.splice(insertAt, 0, `${childIndent}- [ ] ${sanitized}`)
  return lines.join('\n')
}
