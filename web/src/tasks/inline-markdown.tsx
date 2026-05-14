import type { ReactNode } from 'react'

/**
 * Tiny inline-markdown renderer for task titles.
 *
 * Handles the three patterns Orchestrators actually emit in
 * `.hive/tasks.md` task lines: **bold**, *italic*, and `code`. Anything
 * else (links, images, raw HTML, block-level constructs) passes through
 * as plain text. This is intentional: tasks are single-line summaries,
 * not documents — pulling in `react-markdown` would be ~30kB for one
 * `<strong>`.
 *
 * Returns a ReactNode array so the caller can drop it straight into
 * JSX. No HTML escaping needed; React escapes string children.
 */
export const renderInlineMarkdown = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = []
  let buffer = ''
  let key = 0
  const flush = () => {
    if (buffer) {
      nodes.push(buffer)
      buffer = ''
    }
  }
  let i = 0
  while (i < text.length) {
    const remaining = text.slice(i)
    const bold = remaining.match(/^\*\*([^*]+?)\*\*/)
    if (bold?.[1]) {
      flush()
      nodes.push(<strong key={key++}>{renderInlineMarkdown(bold[1])}</strong>)
      i += bold[0].length
      continue
    }
    const code = remaining.match(/^`([^`]+?)`/)
    if (code?.[1]) {
      flush()
      nodes.push(
        <code key={key++} className="mono">
          {code[1]}
        </code>
      )
      i += code[0].length
      continue
    }
    const italic = remaining.match(/^\*([^*]+?)\*/)
    if (italic?.[1]) {
      flush()
      nodes.push(<em key={key++}>{renderInlineMarkdown(italic[1])}</em>)
      i += italic[0].length
      continue
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return nodes
}
