/**
 * A tool call in the reader's words — desktop only. The Assistant panel shows
 * each call as a line of what the assistant is doing ("Reviewing the lettering
 * on page 7") rather than `review_lettering {"pageId":7}`, which is what the
 * folded row showed first and which only someone who knew the tools could read.
 * The name and the arguments are still there, a click away.
 *
 * Pure, and keyed by the tool's name; a tool not listed here is said by its
 * name, so a tool added to the server shows up as itself rather than not at
 * all.
 */
import type { ToolCall } from './messages'

/** What the panel says about a call: while it runs, once it has, and a detail beside it. */
export interface Described {
  doing: string
  done: string
  detail?: string
  /** Which family of tool, for its icon. */
  kind: 'look' | 'read' | 'image' | 'fix' | 'blocks' | 'translate' | 'letter' | 'clean' | 'notes' | 'playbook' | 'other'
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "page 7", "pages 3–5", or "the page on screen". */
function pages (args: Record<string, unknown>): string {
  const ids = Array.isArray(args.pageIds)
    ? args.pageIds
    : Array.isArray(args.pages) ? (args.pages as { pageId?: unknown }[]).map((page) => page?.pageId) : [args.pageId]
  const named = ids.filter((id): id is number => typeof id === 'number')

  if (!named.length) return 'the page on screen'
  if (named.length === 1) return `page ${named[0]}`

  const sorted = [...named].sort((a, b) => a - b)
  const run = sorted.every((id, at) => !at || id === sorted[at - 1]! + 1)

  return run ? `pages ${sorted[0]}–${sorted.at(-1)}` : `${plural(named.length, 'page')}`
}

export function describeCall (call: ToolCall): Described {
  const args = call.arguments
  const on = pages(args)

  switch (call.name) {
    case 'read_playbook':
      return { doing: `Reading the playbook on ${String(args.topic ?? '…')}`, done: `Read the playbook on ${String(args.topic ?? '…')}`, kind: 'playbook' }
    case 'get_active_workspace':
      return { doing: 'Looking at the open chapter', done: 'Looked at the open chapter', kind: 'look' }
    case 'list_pages':
      return { doing: 'Listing the pages', done: 'Listed the pages', detail: typeof args.needs === 'string' ? `needing ${args.needs}` : undefined, kind: 'look' }
    case 'read_page':
      return { doing: `Reading ${on}`, done: `Read ${on}`, kind: 'look' }
    case 'request_page_read':
      return { doing: `Reading ${on} with OCR`, done: `Read ${on} with OCR`, kind: 'read' }
    case 'review_page_reading':
      return { doing: `Checking the reading of ${on}`, done: `Checked the reading of ${on}`, kind: 'read' }
    case 'get_page_image':
      return { doing: `Looking at ${on}`, done: `Looked at ${on}`, detail: typeof args.blockId === 'number' ? `block ${args.blockId}` : args.region ? 'a region' : undefined, kind: 'image' }
    case 'correct_blocks':
      return { doing: `Correcting ${plural(count(args.corrections), 'block')}`, done: `Corrected ${plural(count(args.corrections), 'block')}`, detail: on, kind: 'fix' }
    case 'join_blocks':
      return { doing: `Joining ${plural(count(args.blockIds), 'block')}`, done: `Joined ${plural(count(args.blockIds), 'block')}`, detail: on, kind: 'blocks' }
    case 'split_block':
      return { doing: 'Splitting a block', done: 'Split a block', detail: typeof args.blockId === 'number' ? `block ${args.blockId}` : undefined, kind: 'blocks' }
    case 'save_page_blocks':
      return { doing: `Saving blocks on ${on}`, done: `Saved blocks on ${on}`, detail: typeof args.mode === 'string' ? args.mode : undefined, kind: 'blocks' }
    case 'sort_page_blocks':
      return { doing: `Sorting the blocks of ${on}`, done: `Sorted the blocks of ${on}`, kind: 'blocks' }
    case 'clean_page':
      return { doing: `Cleaning ${on}`, done: `Cleaned ${on}`, kind: 'clean' }
    case 'prepare_page_translation':
      return { doing: `Preparing the translation of ${on}`, done: `Prepared the translation of ${on}`, kind: 'translate' }
    case 'save_page_translations':
      return { doing: `Saving translations for ${on}`, done: `Saved translations for ${on}`, kind: 'translate' }
    case 'review_lettering':
      return { doing: `Reviewing the lettering of ${on}`, done: `Reviewed the lettering of ${on}`, kind: 'letter' }
    case 'set_lettering_style': {
      const lines = count(args.frames) || count(args.blockIds)
      const what = lines ? plural(lines, 'line') : 'every line'

      return { doing: `Restyling ${what}`, done: `Restyled ${what}`, detail: on, kind: 'letter' }
    }
    case 'set_lettering_standard':
      return { doing: 'Setting the standard size', done: 'Set the standard size', detail: typeof args.size === 'number' ? `${args.size}px` : undefined, kind: 'letter' }
    case 'get_glossary':
      return { doing: 'Reading the glossary', done: 'Read the glossary', kind: 'notes' }
    case 'get_cast':
      return { doing: 'Reading the cast', done: 'Read the cast', kind: 'notes' }
    default:
      return { doing: call.name, done: call.name, kind: 'other' }
  }
}
