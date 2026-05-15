export interface ParsedTask {
  checked: boolean
  children: ParsedTask[]
  indent: number
  line: number
  mentions: string[]
  text: string
}

const TASK_LINE = /^(\s*)-\s+\[( |x|X)\]\s+(.*)$/

const extractMentions = (text: string): string[] => {
  const matches = text.match(/@[A-Za-z0-9_-]+/g)
  return matches ? matches : []
}

export const parseTaskMarkdown = (content: string): ParsedTask[] => {
  const root: ParsedTask[] = []
  const stack: ParsedTask[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (!rawLine) continue
    const match = rawLine.match(TASK_LINE)
    if (!match) continue
    const [, indentRaw = '', mark = ' ', textRaw = ''] = match
    const indent = indentRaw.replace(/\t/g, '  ').length
    const task: ParsedTask = {
      checked: mark.toLowerCase() === 'x',
      children: [],
      indent,
      line: i,
      mentions: extractMentions(textRaw),
      text: textRaw.replace(/@[A-Za-z0-9_-]+/g, '').trim(),
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
  const trimmed = nextText.trim()
  if (!trimmed) return content
  const next = target.replace(TASK_LINE, (_, indent, mark) => {
    return `${indent}- [${mark}] ${trimmed}`
  })
  lines[lineIndex] = next
  return lines.join('\n')
}

/**
 * Drop the task at `lineIndex` and every nested-deeper sibling line beneath
 * it (until we encounter a peer or shallower line). Non-task neighbour lines
 * (blank, headings, prose) remain intact so user-authored context isn't
 * collateral.
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
  const trimmed = text.trim()
  if (!trimmed) return content
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
  lines.splice(insertAt, 0, `${childIndent}- [ ] ${trimmed}`)
  return lines.join('\n')
}
