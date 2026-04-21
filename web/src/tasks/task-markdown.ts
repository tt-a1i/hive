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
