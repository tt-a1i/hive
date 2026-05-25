const ANCHOR_RE = /<!--\s*tid:([0-9a-f-]{36})\s*-->$/

export const parseAnchors = (content: string): Map<number, string> => {
  const result = new Map<number, string>()
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(ANCHOR_RE)
    if (match?.[1]) result.set(i, match[1])
  }
  return result
}

export const injectAnchor = (content: string, lineIndex: number, taskId: string): string => {
  const lines = content.split('\n')
  if (lineIndex < 0 || lineIndex >= lines.length) return content
  lines[lineIndex] = `${lines[lineIndex]} <!-- tid:${taskId} -->`
  return lines.join('\n')
}

const normalize = (text: string): string =>
  text
    .replace(/^- \[[ x]\]\s*/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/@\S+/g, '')
    .replace(/<!--[^>]*-->/g, '')
    .trim()
    .toLowerCase()

export const findTaskByTitle = (
  content: string,
  title: string
): { lineIndex: number; existingAnchor?: string } | null => {
  const target = normalize(title).toLowerCase()
  if (!target) return null
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.match(/^- \[[ x]\]/)) continue
    const norm = normalize(line)
    if (norm === target) {
      const anchorMatch = line.match(ANCHOR_RE)
      return { lineIndex: i, ...(anchorMatch?.[1] ? { existingAnchor: anchorMatch[1] } : {}) }
    }
  }
  return null
}
