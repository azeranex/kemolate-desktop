/**
 * The little of Markdown a model's reply uses, parsed for the Assistant panel —
 * desktop only.
 *
 * Models answer in Markdown whether asked to or not, and shown as text a reply
 * came out as "There is **one page** here". What they use in a few lines about
 * a page is paragraphs, bullet and numbered lists, a heading now and then,
 * bold, italics and code; this reads exactly that and nothing more. Hand-rolled
 * for the reason the PDF reader and the zip writer are: a renderer package is
 * a dependency, and an HTML one is also a way for a model's words to become
 * markup — this returns a tree the panel draws as elements (`AssistantMarkdown`),
 * so whatever a reply says stays text.
 *
 * Anything it does not know is a paragraph of plain text, never lost.
 */

export type Inline =
  | { type: 'text', text: string }
  | { type: 'strong', text: string }
  | { type: 'em', text: string }
  | { type: 'code', text: string }

export type Block =
  | { type: 'p', inline: Inline[] }
  | { type: 'h', inline: Inline[] }
  | { type: 'ul' | 'ol', items: Inline[][] }
  | { type: 'code', text: string }

/** Bold before italics, so `**a**` is not read as two empty italics round a word. */
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g

export function inline (text: string): Inline[] {
  const out: Inline[] = []
  let at = 0

  for (const match of text.matchAll(INLINE)) {
    const token = match[0]

    if (match.index > at) out.push({ type: 'text', text: text.slice(at, match.index) })

    if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) })
    else if (token.startsWith('**') || token.startsWith('__')) out.push({ type: 'strong', text: token.slice(2, -2) })
    else out.push({ type: 'em', text: token.slice(1, -1) })

    at = match.index + token.length
  }

  if (at < text.length) out.push({ type: 'text', text: text.slice(at) })

  return out
}

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/

export function markdown (text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', inline: inline(paragraph.join('\n')) })
    paragraph = []
  }

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!

    if (line.trimStart().startsWith('```')) {
      flush()

      const code: string[] = []

      for (at += 1; at < lines.length && !lines[at]!.trimStart().startsWith('```'); at++) code.push(lines[at]!)
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }

    const list = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null

    if (list) {
      flush()

      const pattern = list === 'ul' ? BULLET : NUMBERED
      const items: Inline[][] = []

      for (; at < lines.length && pattern.test(lines[at]!); at++) items.push(inline(pattern.exec(lines[at]!)![1]!))
      at -= 1
      blocks.push({ type: list, items })
      continue
    }

    const heading = HEADING.exec(line)

    if (heading) {
      flush()
      blocks.push({ type: 'h', inline: inline(heading[1]!) })
    } else if (!line.trim()) {
      flush()
    } else {
      paragraph.push(line)
    }
  }

  flush()

  return blocks
}
